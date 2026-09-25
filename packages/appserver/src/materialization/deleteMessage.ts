/**
 * Derived-state side-effects for `space.roomy.message.deleteMessage.v0`.
 *
 * The SDK materialiser only deletes the entity rows (the message, and any
 * forward references to it). That is enough for room-scoped READS, but a delete
 * must also unwind the derived state `createMessage` built, or the appserver
 * keeps serving the deleted message out of derived paths that name it:
 *
 *   - `activity_item` → the deleted message stays in the room's
 *     `recent_message_ids` window and keeps being rendered by the activity feed
 *     until the window happens to roll. A room whose messages are ALL deleted
 *     keeps listing as an activity item with a stale message list (or none).
 *   - read-state (unread) → the message is still counted in every reader's
 *     `unread_count`, so deleting unread messages leaves an unread badge that
 *     can never be cleared.
 *
 * Both are the exact mirror of `applyMoveSideEffects`'s source-room unwind, so
 * they reuse its helpers (`rebuildActivityWindow`,
 * `decrementUnreadForRemovedMessages`) — one implementation, so the move path
 * and the delete path cannot drift apart.
 *
 * Read-state is live-only, as it is for moves: the boot recovery migration
 * re-derives membership, not unread counts, so replaying an old delete over a
 * newer read-state would corrupt the counts.
 */

import type { DbLike } from "../db/types.ts";
import type { DecodedStreamEvent } from "@roomy-space/sdk";
import {
  rebuildActivityWindow,
  decrementUnreadForRemovedMessages,
} from "./roomDerivedState.ts";
import { rebuildRoomActivity } from "../queries/roomActivityProjection.ts";

/** A delete the side-effects stage needs, with its pre-delete ordering key. */
export interface PendingDelete {
  roomId: string;
  /**
   * The message's `sort_idx` as it was BEFORE the delete SQL ran. Captured by
   * the caller while the row still exists — after the delete it is
   * unrecoverable, and it is the key `createMessage`'s unread increment was
   * counted against (an edit or reorder can have moved it off the ULID time).
   */
  sortIdx: string;
}

/**
 * Apply a chunk's deletes.
 *
 * `db` is the per-space DB; `readStateDb` is absent in contexts that don't
 * route read-state (and the unread unwind is skipped there, as in the move
 * path).
 */
export async function applyDeleteSideEffects(
  db: DbLike,
  deletes: readonly PendingDelete[],
  opts: { readStateDb?: DbLike; isBackfill: boolean },
): Promise<void> {
  if (deletes.length === 0) return;

  // The activity window is derived state of the per-space DB, so it is rebuilt
  // on backfill too — a replay must leave the window matching the room's
  // contents, exactly as the move path does. Rebuilding once per affected room
  // (not once per delete) keeps a batch of N deletes in one room from
  // recomputing the same window N times.
  const rooms = new Set<string>();
  for (const d of deletes) if (d.roomId) rooms.add(d.roomId);
  for (const roomId of rooms) await rebuildActivityWindow(db, roomId);

  // `room_activity` was invalidated by the delete's own maintenance step
  // (applyBatch), so restore it here, from the rows that now remain. Same
  // backfill rule as the window above: a replay must leave the projection
  // matching the room's contents, and a rebuild is not population — it
  // describes data the replay just wrote.
  await rebuildRoomActivity(db, [...rooms]);

  if (!opts.readStateDb || opts.isBackfill) return;

  // Group the ordering keys by room so each reader row is updated once per
  // room rather than once per deleted message.
  const byRoom = new Map<string, string[]>();
  for (const d of deletes) {
    if (!d.roomId) continue;
    const list = byRoom.get(d.roomId);
    if (list) list.push(d.sortIdx);
    else byRoom.set(d.roomId, [d.sortIdx]);
  }
  for (const [roomId, sortIndexes] of byRoom) {
    await decrementUnreadForRemovedMessages(opts.readStateDb, roomId, sortIndexes);
  }
}

/**
 * Read the ordering keys of the messages a chunk is about to delete, keyed by
 * message id. Called BEFORE the chunk's SQL runs — the rows are gone after, and
 * with them the only record of the ordering key `createMessage` counted the
 * unread increment against.
 */
export async function captureDeleteSortIndexes(
  db: DbLike,
  messageIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (messageIds.length === 0) return out;
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = await db
    .query(`select id, sort_idx from entities where id in (${placeholders})`)
    .all<{ id: string; sort_idx: string | null }>([...messageIds]);
  for (const row of rows) {
    // A NULL sort_idx (a row whose sort pass never ran) falls back to the id,
    // which is the same ULID-time ordering key `selectMessages` uses.
    out.set(row.id, row.sort_idx ?? row.id);
  }
  return out;
}

/**
 * Collect a chunk's deletes and read their ordering keys in one query.
 *
 * Takes the decoded events the write path holds, so the read happens once for
 * the whole chunk rather than per event. MUST be called before the chunk's SQL
 * runs — the rows, and with them the ordering keys, are gone after.
 */
export async function collectPendingDeletes(
  db: DbLike,
  chunk: readonly DecodedStreamEvent[],
): Promise<PendingDelete[]> {
  const targets: { roomId: string; messageId: string }[] = [];
  for (const decoded of chunk) {
    const event = decoded.event as {
      $type: string;
      room?: unknown;
      messageId?: unknown;
    };
    if (event.$type !== "space.roomy.message.deleteMessage.v0") continue;
    const roomId = typeof event.room === "string" ? event.room : "";
    const messageId = typeof event.messageId === "string" ? event.messageId : "";
    if (!roomId || !messageId) continue;
    targets.push({ roomId, messageId });
  }
  if (targets.length === 0) return [];

  const sortIndexes = await captureDeleteSortIndexes(
    db,
    targets.map((t) => t.messageId),
  );
  return targets.map((t) => ({
    roomId: t.roomId,
    sortIdx: sortIndexes.get(t.messageId) ?? t.messageId,
  }));
}