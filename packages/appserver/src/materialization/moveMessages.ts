/**
 * Materialization side-effects for `space.roomy.message.moveMessages.v0`.
 *
 * The SDK materialiser only rewrites `entities.room` — enough for
 * room-scoped READS to be correct, but not enough for a move to be correct
 * anywhere derived data is keyed by the message's room, or for the unread
 * bookkeeping that createMessage maintains. The side-effects here mirror
 * `applyBundle`'s createMessage path for the DESTINATION and unwind it for
 * the SOURCE:
 *
 *   - `sort_idx`           → the move event's own ULID time (see
 *                            `setMessageSortIdxByMove`) so a moved message is
 *                            visible at the top of the destination timeline
 *                            instead of buried at its original send time.
 *   - `activity_item`      → destination window gains the message; source
 *                            window is rebuilt from the room's remaining
 *                            newest 5 (the moved message may have been one of
 *                            them, and the ones beyond the window were never
 *                            stored).
 *   - read-state (unread)  → destination +1 for every tracker of the room
 *                            (threads: only engaged users), source decremented
 *                            EXACTLY — one per moved message the user had not
 *                            yet read, never below zero.
 *   - thread activity      → a move into a thread re-surfaces it for everyone
 *                            tracking it, at the move time, and registers the
 *                            message's author as tracking it (their content
 *                            now lives there).
 *   - `user_room_participation` → the author gains participation in the
 *                            destination and loses it in the source only when
 *                            they have no other messages left there.
 *
 * The global mentions index (`mentions.room_id`) is NOT touched here — it is
 * owned by `syncMentionsIndex`, which the invalidation router drives for the
 * same event (see `MoveMessages` there).
 */

import type { DbLike } from "../db/types.ts";
import type { Event, StreamDid, Ulid } from "@roomy-space/sdk";
import { decodeTime, ulid } from "ulidx";
import { upsertActivityItem } from "./activityItem.ts";
import {
  decrementUnreadForRemovedMessages,
  rebuildActivityWindow,
} from "./roomDerivedState.ts";
import { rebuildRoomActivity } from "../queries/roomActivityProjection.ts";
import { setMessageSortIdxByMove } from "./sortIdx.ts";
import { isThread, refreshThreadActivityOnMessage } from "../queries/userActiveThreads.ts";
import { upsertUserRoomParticipation } from "../queries/userRoomParticipation.ts";
import { log } from "../log.ts";

/** The subset of a moveMessages event the side-effects need. */
interface MoveMessagesEvent {
  id: Ulid;
  room: Ulid;
  toRoomId: Ulid;
  messageIds: readonly Ulid[];
}

/** Per-moved-message facts read before the move's derived state is unwound. */
interface MovedMessage {
  id: string;
  /** `comp_content.timestamp` — the canonical send time, null for a legacy
   *  forward reference (no own content). */
  timestamp: number | null;
  /** Effective author DID (the `author` edge), null when unresolved. */
  authorDid: string | null;
}

/**
 * Apply the move's derived-state side-effects.
 *
 * `db` is the per-space DB (both rooms live in the same space — a move is a
 * within-space operation; `writeAuth` rejects cross-space destinations).
 */
export async function applyMoveSideEffects(
  db: DbLike,
  opts: {
    streamId: StreamDid;
    event: Event;
    readStateDb?: DbLike;
    /** True for backfill/replay — skips the read-state mutations. */
    isBackfill: boolean;
  },
): Promise<void> {
  const e = opts.event;
  if (e.$type !== "space.roomy.message.moveMessages.v0") return;
  const event = e as unknown as MoveMessagesEvent;
  if (!event.room || !event.toRoomId) return;

  const spaceId = opts.streamId;
  // Activity timestamps use the move event's own time, matching the
  // `sort_idx` the message now carries — otherwise the feed's window order
  // and the timeline order would disagree.
  const movedAt = decodeTime(event.id);

  // Ordering: the moved message takes the move event's time so it lands at
  // the top of the destination timeline instead of being buried at its
  // original send time (see `setMessageSortIdxByMove`). It lives in this
  // helper — not in `applyBundle`'s sort_idx block — so the ordering and the
  // activity timestamps below are computed from the same instant and can
  // never drift apart.
  await setMessageSortIdxByMove(db, opts.event);

  const moved = await readMovedMessages(db, event.messageIds);
  if (moved.length === 0) return;

  // ── Per-space: activity feed windows ──────────────────────────────────
  for (const m of moved) {
    await upsertActivityItem(db, {
      roomId: event.toRoomId,
      spaceId,
      messageId: m.id as Ulid,
      timestamp: movedAt,
    });
  }
  await rebuildActivityWindow(db, event.room);
  await rebuildActivityWindow(db, event.toRoomId);
  // `room_activity` was invalidated for both rooms by the move's own
  // maintenance step; restore both from the post-move tables. Also on backfill,
  // for the same reason the windows above are.
  await rebuildRoomActivity(db, [event.room, event.toRoomId]);

  // ── Read-state: unread counts, thread activity, participation ─────────
  // Live events only, mirroring createMessage's unread bump in `applyBundle`:
  // read-state is appserver-owned and not reconstructed by replay (the boot
  // recovery migration re-derives membership only), so replaying an old move
  // over a newer read-state would corrupt the counts.
  const readStateDb = opts.readStateDb;
  if (!readStateDb || opts.isBackfill) return;

  if (await isThread(db, event.toRoomId)) {
    for (const m of moved) {
      if (m.authorDid) {
        await refreshThreadActivityOnMessage(
          readStateDb,
          event.toRoomId,
          m.authorDid,
          spaceId,
          movedAt,
        );
      }
    }
  }

  await bumpDestinationUnread(db, readStateDb, event.toRoomId, spaceId);
  await decrementSourceUnread(readStateDb, event.room, moved);

  for (const m of moved) {
    if (!m.authorDid) continue;
    await upsertUserRoomParticipation(readStateDb, m.authorDid, event.toRoomId, movedAt);
    await clearSourceParticipationIfNoneLeft(db, readStateDb, event.room, m.authorDid);
  }
}

/**
 * Read the moved messages' canonical timestamp and author. `sort_idx` is not
 * read — by the time these side-effects run the move has already rewritten
 * it, and the source-side unread math reconstructs the original from
 * `comp_content.timestamp` (see `decrementSourceUnread`).
 */
async function readMovedMessages(
  db: DbLike,
  messageIds: readonly Ulid[],
): Promise<MovedMessage[]> {
  if (messageIds.length === 0) return [];
  const ph = messageIds.map(() => "?").join(",");
  const rows = await db
    .query(
      `select e.id as id, cc.timestamp as timestamp, author_e.tail as author_did
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges author_e on author_e.head = e.id and author_e.label = 'author'
        where e.id in (${ph})`,
    )
    .all<{ id: string; timestamp: number | null; author_did: string | null }>([
      ...messageIds,
    ]);
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    authorDid: r.author_did,
  }));
}


/**
 * Destination unread bump. Mirrors `applyBundle`'s createMessage path: a
 * channel bumps every user with a `read_positions` row; a thread bumps only
 * users who have engaged with it (lazily creating their row).
 */
async function bumpDestinationUnread(
  db: DbLike,
  readStateDb: DbLike,
  roomId: string,
  spaceId: StreamDid,
): Promise<void> {
  if (await isThread(db, roomId)) {
    const maxSortRow = await db
      .query("select max(sort_idx) as m from entities where room = ?")
      .get<{ m: string | null }>([roomId]);
    const seenUpTo = maxSortRow?.m ?? "0";
    await readStateDb.run(
      `insert into read_positions (user_did, room_id, space_did, seen_up_to, unread_count, updated_at)
       select uta.user_did, ?, ?, ?, 1, (unixepoch() * 1000)
         from user_thread_activity uta
        where uta.thread_id = ?
       on conflict(user_did, room_id) do update set
         unread_count = unread_count + 1,
         updated_at = (unixepoch() * 1000)`,
      [roomId, spaceId, seenUpTo, roomId],
    );
    return;
  }

  await readStateDb.run(
    `update read_positions
        set unread_count = unread_count + 1,
            updated_at = (unixepoch() * 1000)
      where room_id = ?`,
    [roomId],
  );
}

/**
 * Source unread decrement. The moved message's `sort_idx` has already been
 * rewritten by the move, so the ORIGINAL ordering key is reconstructed from
 * `comp_content.timestamp` (falling back to the id's own time for a
 * content-less forward).
 *
 * Caveat: a message that was *reordered* before being moved carries a
 * mid-pointed `sort_idx` that is not reproducible from its timestamp; the
 * reconstruction is then off by less than a millisecond, which can only
 * mis-decide a message sitting exactly on a user's watermark.
 */
async function decrementSourceUnread(
  readStateDb: DbLike,
  sourceRoomId: string,
  moved: readonly MovedMessage[],
): Promise<void> {
  const originalSortIdx = moved.map(
    (m) => ulid(m.timestamp ?? decodeTime(m.id)) as string,
  );
  await decrementUnreadForRemovedMessages(readStateDb, sourceRoomId, originalSortIdx);
}

/**
 * Drop the author's participation row for the source room — but only when
 * they have no other messages left there. Participation means "this user has
 * spoken in this room", so it survives a move while any of their messages
 * remain.
 */
async function clearSourceParticipationIfNoneLeft(
  db: DbLike,
  readStateDb: DbLike,
  sourceRoomId: string,
  authorDid: string,
): Promise<void> {
  const remaining = await db
    .query(
      `select 1 as n
         from entities e
         join edges a on a.head = e.id and a.label = 'author'
        where e.room = ? and a.tail = ?
        limit 1`,
    )
    .get<{ n: number }>([sourceRoomId, authorDid]);
  if (remaining) return;
  try {
    await readStateDb.run(
      `delete from user_room_participation where user_did = ? and room_id = ?`,
      [authorDid, sourceRoomId],
    );
  } catch (err) {
    // Participation is a digest-gate signal, not correctness: a failed delete
    // must not roll back the move itself.
    log.warn(
      `[materialize] moveMessages: could not clear participation for ${authorDid} in ${sourceRoomId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
