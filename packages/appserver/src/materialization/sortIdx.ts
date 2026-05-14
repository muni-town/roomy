/**
 * Sort-index materialisation for messages.
 *
 * Ported from `packages/app/src/lib/workers/sqlite/worker.ts` —
 * `materializeEntitySortPositionByTimestamp` and `materializeEntitySortPosition`.
 *
 * Kept *outside* the SDK materialisers because the original design
 * deliberately keeps materialisers backfill-agnostic and free of
 * extension-aware ordering logic.
 */

import { Database } from "bun:sqlite";
import { decodeTime, ulid } from "ulidx";
import type { Event, StreamDid, Ulid } from "@roomy-space/sdk";

/**
 * Set `entities.sort_idx` for a freshly-created message based on its canonical
 * timestamp. For Discord-bridged messages we honour the timestampOverride
 * extension; otherwise we use the message's own ULID timestamp.
 *
 * No-op if the entity row is missing (materialiser failed earlier in the
 * batch) or if a sort_idx is already set.
 */
export function setMessageSortIdxByTimestamp(db: Database, event: Event): void {
  if (event.$type !== "space.roomy.message.createMessage.v0") return;

  const overrideExt =
    event.extensions?.["space.roomy.extension.timestampOverride.v0"];
  const timestamp = overrideExt
    ? Number(overrideExt.timestamp)
    : decodeTime(event.id);

  const existing = db
    .query<
      { sort_idx: string | null },
      [string]
    >("select sort_idx from entities where id = ?")
    .get(event.id);

  if (!existing || existing.sort_idx) return;

  const sortIdx = ulid(timestamp);
  db.prepare("update entities set sort_idx = ? where id = ?").run(
    sortIdx,
    event.id,
  );
}

/**
 * Set `entities.sort_idx` for a message moved by a `reorderMessage` event,
 * placing it lexicographically between the entity referenced by `after` and
 * whichever entity currently sorts immediately after that one.
 *
 * Only invoked for `space.roomy.message.reorderMessage.v0` events that carry
 * an `after` field.
 */
export function setMessageSortIdxByReorder(
  db: Database,
  streamId: StreamDid,
  event: Event,
): void {
  if (event.$type !== "space.roomy.message.reorderMessage.v0") return;
  if (!event.after) return;

  const messageId = event.messageId as Ulid;
  const after = event.after as Ulid;

  const existing = db
    .query<
      { sort_idx: string | null },
      [string]
    >("select sort_idx from entities where id = ?")
    .get(messageId);
  if (!existing) return; // materialiser failed earlier

  // Reorder always overwrites sort_idx — fall through even if one already
  // exists. This matches the frontend's `update: true` semantics.

  const before = db
    .query<{ sort_idx: string }, [string, string]>(
      `select coalesce(sort_idx, id) as sort_idx
       from entities
       where stream_id = ? and id = ?
       limit 1`,
    )
    .get(streamId, after);

  if (!before) {
    console.warn(
      `[materialize] reorderMessage: 'after' entity ${after} not found for stream ${streamId}`,
    );
    return;
  }

  const next = db
    .query<{ sort_idx: string }, [string, string, string]>(
      `select sort_idx
       from entities
       where stream_id = ?
         and sort_idx > ?
         and id != ?
       order by sort_idx
       limit 1`,
    )
    .get(streamId, before.sort_idx, messageId);

  let sortIdx: string;
  try {
    sortIdx = midpointUlid(
      before.sort_idx as Ulid,
      next?.sort_idx as Ulid | undefined,
    );
  } catch (e) {
    console.warn(
      `[materialize] reorderMessage: could not compute midpoint for ${messageId}:`,
      e,
    );
    return;
  }

  db.prepare("update entities set sort_idx = ? where id = ?").run(
    sortIdx,
    messageId,
  );
}

/**
 * Lexicographic midpoint between two ULIDs. If `later` is missing we sort the
 * new entry 10 ms after `earlier`. Mirrors the frontend's `midpointUlid`
 * helper in `worker.ts`.
 */
function midpointUlid(earlier: Ulid, later?: Ulid): string {
  const earlierTime = decodeTime(earlier);
  const laterTime = later ? decodeTime(later) : earlierTime + 10;
  const midTime = earlierTime + (laterTime - earlierTime) / 2;
  return ulid(midTime);
}
