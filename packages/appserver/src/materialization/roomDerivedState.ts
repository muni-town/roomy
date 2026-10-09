/**
 * Derived state that depends on a room's CURRENT message set.
 *
 * `rebuildActivityWindow` recomputes `activity_item.recent_message_ids` from
 * the room's newest message-shaped rows, deleting the row when the room is
 * empty so the activity feed stops listing a gutted room.
 *
 * Both places a room's messages can grow or shrink — `moveMessages` (source
 * room) and `deleteMessage` — need it, so it lives here rather than in either
 * caller: a second copy is how the two paths drift.
 *
 * Unread is deliberately absent. It is the difference between a reader's
 * position (`read_positions.seen_up_to`) and the room's message set, so a
 * message leaving the room lowers every affected count the moment the delete
 * or move lands — nothing here has to adjust it. See
 * `queries/readPositions.ts:deriveUnreadCounts`.
 *
 * The `room_activity` board projection needs the same "a room's messages just
 * changed, re-derive its summary" step, but it lives with its own read path in
 * `queries/roomActivityProjection.ts` (`rebuildRoomActivity`), which owns the
 * projection's schema, maintenance rules and fallback.
 */

import type { DbLike } from "../db/types.ts";
import type { Ulid } from "@roomy-space/sdk";
import { decodeTime } from "ulidx";

/**
 * Recompute a room's `activity_item.recent_message_ids` window from the room's
 * current newest 5 message-shaped rows, ordered by `sort_idx` descending —
 * the same filter and order the `selectMessages` timeline uses (a row needs
 * own content or a forward edge to be a message). Leaves `last_activity_at`
 * at the newest entry's canonical time; when the room has no messages left
 * the row is deleted so the feed stops listing it.
 *
 * Callers: the source room after a move, and after any message deletion.
 */
export async function rebuildActivityWindow(db: DbLike, roomId: string): Promise<void> {
  const rows = await db
    .query(
      `select e.id as id, e.sort_idx as sort_idx
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges forward_e on forward_e.head = e.id and forward_e.label = 'forward'
        where e.room = ?
          and (cc.entity is not null or forward_e.tail is not null)
        order by e.sort_idx desc
        limit 5`,
    )
    .all<{ id: string; sort_idx: string | null }>([roomId]);

  if (rows.length === 0) {
    await db.run("delete from activity_item where room_id = ?", [roomId]);
    return;
  }

  // A sort key's time component is the message's ORDERING time, so the feed
  // orders this window by the same instant the timeline does — no second read
  // of comp_content needed.
  const entries = rows.map((r) => ({
    id: r.id,
    ts: decodeTime((r.sort_idx ?? r.id) as Ulid),
  }));

  await db.run(
    `update activity_item
        set last_activity_at = ?,
            recent_message_ids = ?,
            updated_at = (unixepoch() * 1000)
      where room_id = ?`,
    [entries[0]!.ts, JSON.stringify(entries), roomId],
  );
}
