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

import type { DbLike } from "../db/types.ts";
import { decodeTime, ulid } from "ulidx";
import type { Event, StreamDid, Ulid } from "@roomy-space/sdk";
import { log } from "../log.ts";

/**
 * Set `entities.sort_idx` for a freshly-created message based on its canonical
 * timestamp. For Discord-bridged messages we honour the timestampOverride
 * extension; otherwise we use the message's own ULID timestamp.
 *
 * No-op if the entity row is missing (materialiser failed earlier in the
 * batch) or if a sort_idx is already set.
 */
export async function setMessageSortIdxByTimestamp(db: DbLike, event: Event): Promise<void> {
  if (event.$type !== "space.roomy.message.createMessage.v0") return;

  const overrideExt =
    event.extensions?.["space.roomy.extension.timestampOverride.v0"];
  const timestamp = overrideExt
    ? Number(overrideExt.timestamp)
    : decodeTime(event.id);

  const sortIdx = ulid(timestamp);
  // No SELECT needed: the entity was just created by ensureEntity in the same
  // savepoint with sort_idx = NULL. If the row is missing or sort_idx is
  // already set, this UPDATE is a no-op.
  await db.run("update entities set sort_idx = ? where id = ? and sort_idx is null", sortIdx, event.id);
}

/**
 * Set `entities.sort_idx` for a forward-reference entity created by a
 * `forwardMessages` event, using the forward event's own ULID time.
 *
 * The forward-reference entity has no comp_content of its own, so without
 * this its sort_idx stays NULL and selectMessages falls back to ordering by
 * the entity id — which is the forward event's ULID anyway, so the fallback
 * would place it correctly. This explicit write keeps the sort_idx column
 * populated (consistent with every other message) and makes the forward
 * appear at the top of the destination room's timeline, matching the modern
 * forward-as-embed representation (createMessage + forward attachment).
 *
 * Previously the original message's sort_idx was copied here, which placed a
 * forward of an old message deep in history — outside the first getMessages
 * page — so it flashed in via the WS diff and vanished on the next refetch.
 * No-op if the entity row is missing (materialiser failed earlier in the
 * batch) or if a sort_idx is already set.
 */
export async function setMessageSortIdxByForward(db: DbLike, event: Event): Promise<void> {
  if (event.$type !== "space.roomy.message.forwardMessages.v0") return;

  const sortIdx = ulid(decodeTime(event.id)) as Ulid;
  await db.run(
    "update entities set sort_idx = ? where id = ? and sort_idx is null",
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
export async function setMessageSortIdxByReorder(
  db: DbLike,
  streamId: StreamDid,
  event: Event,
): Promise<void> {
  if (event.$type !== "space.roomy.message.reorderMessage.v0") return;
  if (!event.after) return;

  const messageId = event.messageId as Ulid;
  const after = event.after as Ulid;

  const existing = await db
    .query("select sort_idx from entities where id = ?")
    .get<{ sort_idx: string | null }>(messageId);
  if (!existing) return; // materialiser failed earlier

  // Reorder always overwrites sort_idx — fall through even if one already
  // exists. This matches the frontend's `update: true` semantics.

  const before = await db
    .query(
      `select coalesce(sort_idx, id) as sort_idx
       from entities
       where stream_id = ? and id = ?
       limit 1`,
    )
    .get<{ sort_idx: string }>(streamId, after);
  if (!before) {
    log.warn(
      `[materialize] reorderMessage: 'after' entity ${after} not found for stream ${streamId}`,
    );
    return;
  }

  const next = await db
    .query(
      `select sort_idx
       from entities
       where stream_id = ?
         and sort_idx > ?
         and id != ?
       order by sort_idx
       limit 1`,
    )
    .get<{ sort_idx: string }>(streamId, before.sort_idx, messageId);

  let sortIdx: string;
  try {
    sortIdx = midpointUlid(
      before.sort_idx as Ulid,
      next?.sort_idx as Ulid | undefined,
    );
  } catch (e) {
    log.warn(
      `[materialize] reorderMessage: could not compute midpoint for ${messageId}:`,
      e,
    );
    return;
  }

  await db.run("update entities set sort_idx = ? where id = ?", sortIdx, messageId);
}

/**
 * Lexicographic midpoint between two ULIDs. If `later` is missing we sort the
 * new entry 10 ms after `earlier`. Mirrors the frontend's `midpointUlid`
 * helper in `worker.ts`.
 */
function midpointUlid(earlier: Ulid, later?: Ulid): string {
  if (!later) {
    return ulid(decodeTime(earlier) + 10);
  }
  const e = decodeTime(earlier);
  const l = decodeTime(later);
  if (e === l) {
    // Same millisecond — use the midpoint of the random suffixes.
    const eStr = earlier as string;
    const lStr = later as string;
    const mid = eStr.slice(0, 10) + (BigInt("0x" + eStr.slice(10)) + BigInt("0x" + lStr.slice(10))) / 2n;
    return mid as Ulid;
  }
  return ulid(Math.floor((e + l) / 2));
}

/**
 * Canonical timestamp (ms since epoch) for a message event: the
 * `timestampOverride` extension when present (Discord-bridged messages carry
 * the original Discord send time), otherwise the event ULID's own time.
 *
 * This is the same rule the SDK materialiser uses for `comp_content.timestamp`
 * and `setMessageSortIdxByTimestamp` uses for `entities.sort_idx`. Consumers
 * that derive a timestamp from the message ULID alone (e.g. the activity
 * feed) mis-order bridged messages, whose ULIDs encode bridge-ingestion time
 * rather than the original Discord time.
 */
export function canonicalMessageTimestamp(event: Event): number {
  if (event.$type !== "space.roomy.message.createMessage.v0") {
    return decodeTime(event.id);
  }
  const overrideExt =
    event.extensions?.["space.roomy.extension.timestampOverride.v0"];
  return overrideExt ? Number(overrideExt.timestamp) : decodeTime(event.id);
}
