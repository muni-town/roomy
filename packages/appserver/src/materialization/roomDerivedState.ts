/**
 * Derived state that depends on a room's CURRENT message set.
 *
 * Two operations must agree, wherever a room's messages are added or removed:
 *
 *   - `rebuildActivityWindow` — recompute `activity_item.recent_message_ids`
 *     from the room's newest message-shaped rows, deleting the row when the
 *     room is empty so the activity feed stops listing a gutted room.
 *   - `decrementUnreadForRemovedMessages` — remove exactly the unread messages
 *     a user still owed when messages leave the room, never below zero.
 *
 * The `room_activity` board projection needs the same "a room's messages just
 * changed, re-derive its summary" step, but it lives with its own read path in
 * `queries/roomActivityProjection.ts` (`rebuildRoomActivity`), which owns the
 * projection's schema, maintenance rules and fallback. Only the unread unwind
 * and the feed window are shared from here.
 *
 * `moveMessages` (source room) and `deleteMessage` both need them, so they live
 * here rather than in either caller: a second copy is how the two paths drift.
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

/**
 * Remove messages from every reader's unread count — exact, not a blind `-1`.
 *
 * A user's `unread_count` for a room counts the messages past their
 * `seen_up_to` watermark (createMessage adds one per message). Removing a
 * message must subtract only the messages that were still unread for that
 * user, and the watermark decides it: `originalSortIndexes` are the ordering
 * keys the messages held while they were in the room, and `seen_up_to` is
 * also a stored `sort_idx`, so comparing the two says whether each was unread.
 *
 * Blindly subtracting one per message would corrupt the count for users who
 * had already read them — the count is maintained incrementally, so this is
 * the only place with enough information to be exact.
 *
 * Callers pass the ordering key they can vouch for: a move reconstructs it
 * from `comp_content.timestamp` (the message's `sort_idx` has already been
 * rewritten by then), a delete passes the `sort_idx` it read before the row
 * was removed.
 */
export async function decrementUnreadForRemovedMessages(
  readStateDb: DbLike,
  roomId: string,
  originalSortIndexes: readonly string[],
): Promise<void> {
  if (originalSortIndexes.length === 0) return;

  const rows = await readStateDb
    .query(
      `select user_did, seen_up_to, unread_count
         from read_positions
        where room_id = ? and unread_count > 0`,
    )
    .all<{ user_did: string; seen_up_to: string; unread_count: number }>([roomId]);
  if (rows.length === 0) return;

  for (const row of rows) {
    const unreadRemoved = originalSortIndexes.filter((s) => s > row.seen_up_to).length;
    if (unreadRemoved === 0) continue;
    const next = Math.max(0, row.unread_count - unreadRemoved);
    await readStateDb.run(
      `update read_positions
          set unread_count = ?, updated_at = (unixepoch() * 1000)
        where user_did = ? and room_id = ?`,
      [next, row.user_did, roomId],
    );
  }
}
