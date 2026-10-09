/**
 * Materialization side-effects for `space.roomy.message.moveMessages.v0`.
 *
 * The SDK materialiser only rewrites `entities.room` — enough for
 * room-scoped READS to be correct, but not enough for a move to be correct
 * anywhere derived data is keyed by the message's room. The side-effects here
 * mirror `applyBundle`'s createMessage path for the DESTINATION and unwind it
 * for the SOURCE:
 *
 *   - `sort_idx`           → the move's receipt time (see
 *                            `setMessageSortIdxByMove`) so a moved message is
 *                            visible at the top of the destination timeline
 *   - `activity_item`      → destination window gains the message; source
 *                            window is rebuilt from the room's remaining
 *                            newest 5 (the moved message may have been one of
 *                            them, and the ones beyond the window were never
 *                            stored).
 *   - unread               → nothing to do. A reader's count is derived from
 *                            their read position and the room's message set,
 *                            both of which the move has already updated.
 *   - thread activity      → a move into a thread re-surfaces it for everyone
 *                            tracking it, at the move time, and registers the
 *                            message's author as tracking it (their content
 *                            now lives there).
 *   - `user_room_participation` → the author gains participation in the
 *                            destination and loses it in the source only when
 *                            they have no other messages left there.
 *
 * The global mentions index (`mentions.room_id`) is NOT touched here — it is
 * same event (see `MoveMessages` there).
 */

import type { DbLike } from "../db/types.ts";
import type { Event, StreamDid, StreamIndex, Ulid } from "@roomy-space/sdk";
import { decodeTime } from "ulidx";
import { upsertActivityItem } from "./activityItem.ts";
import { rebuildActivityWindow } from "./roomDerivedState.ts";
import { rebuildRoomActivity } from "../queries/roomActivityProjection.ts";
import { messageOrderTime, setMessageSortIdxByMove } from "./sortIdx.ts";
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
    /** The move event's log position — the sort key's tie-break. */
    idx: StreamIndex;
    /** `stream_events.received_at`: the server's receipt instant. */
    receivedAt?: number;
    /** `stream_events.created_at`: the log's ingest time, the receipt's fallback. */
    createdAt?: number;
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
  // The move's canonical instant: the server's receipt of the event, then the
  // log's ingest time, then the event's own ULID time — the same rule
  // `setMessageSortIdxByMove` keys the ordering by, so the timeline order and
  // the feed's window order use one instant and cannot drift apart.
  const movedAt = messageOrderTime(opts.event, opts.receivedAt, opts.createdAt);

  // Ordering: the moved message takes the move's instant so it lands at the
  // top of the destination timeline instead of being buried at its original
  // send time (see `setMessageSortIdxByMove`).
  await setMessageSortIdxByMove(
    db,
    opts.event,
    opts.idx,
    opts.receivedAt,
    opts.createdAt,
  );

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

  // ── Read-state: thread activity, participation ────────────────────────
  // Unread is not touched: a reader's count is derived from their read
  // position and the room's message set, so moving a message between rooms
  // changes it without anyone adjusting it. What remains here is the state
  // the log cannot supply — which threads a user tracks, and which rooms
  // they have spoken in.
  //
  // Live events only, mirroring createMessage's read-state section in
  // `applyBundle`: a replayed move over a newer read-state would resurrect
  // activity for a thread the user has since stopped tracking.
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
