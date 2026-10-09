/**
 * Read-state v14: make the read position the only stored fact about reading.
 *
 * `read_positions` used to carry `unread_count`, a counter the materialiser
 * adjusted on every message create (`+1`), move and delete (`-1`, exactly).
 * That representation is what the v14 schema drops: a count is the difference
 * between the stored position and the room's message set, so keeping it meant
 * every event that changed the message set had to remember to adjust it — an
 * increment against state outside the log, which is neither deterministic nor
 * idempotent, and a read-modify-write across two databases.
 *
 * A row whose position is real (`seen_up_to` names a message key) needs no
 * work: the position IS the fact, and the count derived from it is the count
 * `updateSeen` computed when it wrote the row. Stale counts on those rows are
 * discarded — the derived value is the correct one, which is the point.
 *
 * A row whose position is a placeholder (`''` or `'0'`, the value a
 * lazily-created row starts with) has no position to keep. It is anchored at
 * the room's newest key — "nothing is unread" — which is what every reader
 * showed it as. The alternative, leaving the placeholder in place, would read
 * as "every message in the room is unread" once the count is derived: the
 * placeholder sorts below every real key.
 *
 * A room whose DB this boot cannot resolve (the room is gone, or its stream is
 * not in the event log) is left alone and counted: its rows have no key set to
 * anchor against, and the boot watermark pass reports that residue.
 *
 * Idempotent and resumable: the anchor it writes IS a key, and a row that
 * holds a real key is skipped, so re-running changes nothing.
 */

import type { DbLike } from "./types.ts";
import { openSpaceDb } from "./db.ts";
import { log } from "../log.ts";

/** Rows updated per transaction. */
const APPLY_CHUNK = 500;
/** Rooms looked up per statement in the global entity→space index. */
const ATTRIBUTE_BATCH = 500;

/**
 * Anchor every placeholder read position at its room's newest message key.
 *
 * Runs before the read-state schema drops `unread_count`, and reads nothing
 * from it: the value is derived from the position and the message set after
 * this, so the migration only has to make the positions mean something.
 */
export async function anchorPlaceholderReadPositions(db: DbLike): Promise<void> {
  const readStateDb = db.readState?.() ?? db;
  const rows = await readStateDb
    .query(
      `select user_did, room_id, space_did from read_positions
        where seen_up_to = '' or seen_up_to = '0'`,
    )
    .all<{ user_did: string; room_id: string; space_did: string }>();

  if (rows.length === 0) return;
  let anchored = 0;
  let unattributed = 0;
  let emptyRooms = 0;

  // Resolve each room's owning space: the column when the materialiser wrote
  // it, else the global entity→space index (what `openSpaceDbForEntity` uses).
  // A row the user's own `updateSeen` wrote carries an empty one.
  const roomSpace = new Map<string, string>();
  for (const r of rows) {
    if (r.space_did !== "") roomSpace.set(r.room_id, r.space_did);
  }
  const unknown = [...new Set(rows.filter((r) => r.space_did === "").map((r) => r.room_id))];
  const globalDb = db.global?.();
  if (unknown.length > 0 && globalDb) {
    for (let i = 0; i < unknown.length; i += ATTRIBUTE_BATCH) {
      const batch = unknown.slice(i, i + ATTRIBUTE_BATCH);
      const found = await globalDb
        .query(
          `select entity_id, space_did from entity_space
            where entity_id in (${batch.map(() => "?").join(",")})`,
        )
        .all<{ entity_id: string; space_did: string }>(...batch);
      for (const r of found) roomSpace.set(r.entity_id, r.space_did);
    }
  }

  const bySpace = new Map<string, Map<string, string[]>>();
  for (const r of rows) {
    const spaceDid = roomSpace.get(r.room_id);
    if (spaceDid === undefined) {
      unattributed++;
      continue;
    }
    const byRoom = bySpace.get(spaceDid) ?? new Map<string, string[]>();
    bySpace.set(spaceDid, byRoom);
    const users = byRoom.get(r.room_id) ?? [];
    byRoom.set(r.room_id, users);
    users.push(r.user_did);
  }

  const updates: Array<{ userDid: string; roomId: string; anchor: string }> = [];
  for (const [spaceDid, byRoom] of bySpace) {
    const spaceDb = openSpaceDb(spaceDid);
    const roomIds = [...byRoom.keys()];
    // One statement per space: each room's newest key, which is the position a
    // reader with nothing unread holds (`updateSeen` writes it explicitly when
    // handed no watermark).
    const newest = await spaceDb
      .query(
        `select room as room_id, max(sort_idx) as newest
           from entities
          where room in (select value from json_each(?1))
          group by room`,
      )
      .all<{ room_id: string; newest: string | null }>(JSON.stringify(roomIds));
    const newestByRoom = new Map(newest.map((r) => [r.room_id, r.newest]));
    for (const [roomId, users] of byRoom) {
      const anchor = newestByRoom.get(roomId);
      if (anchor == null) {
        // The room holds no keyed entity. Leaving the placeholder is correct:
        // the derived count is zero for a room with no messages, which is what
        // the reader was shown.
        emptyRooms += users.length;
        continue;
      }
      for (const userDid of users) updates.push({ userDid, roomId, anchor });
    }
  }

  for (let i = 0; i < updates.length; i += APPLY_CHUNK) {
    const chunk = updates.slice(i, i + APPLY_CHUNK);
    await readStateDb.transaction(
      chunk.map((u) => ({
        type: "run" as const,
        // The placeholder is part of the predicate, not only a value: a boot
        // racing a user's own `updateSeen` must not overwrite a real position
        // with an anchor derived from the value it held before.
        sql: `update read_positions set seen_up_to = ?, updated_at = (unixepoch() * 1000)
               where user_did = ? and room_id = ? and (seen_up_to = '' or seen_up_to = '0')`,
        params: [u.anchor, u.userDid, u.roomId],
      })),
    );
    anchored += chunk.length;
  }

  log.info(
    "startup",
    `read-state read positions anchored: ${anchored} of ${rows.length} placeholder row(s)` +
      (emptyRooms > 0 ? `, ${emptyRooms} in a room with no messages` : "") +
      (unattributed > 0 ? `, ${unattributed} not attributable to a space` : ""),
  );
}
