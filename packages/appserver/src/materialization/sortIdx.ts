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

  const existing = await db
    .query("select sort_idx from entities where id = ?")
    .get<{ sort_idx: string | null }>(event.id);

  if (!existing || existing.sort_idx) return;

  const sortIdx = ulid(timestamp);
  await (await db.prepare("update entities set sort_idx = ? where id = ?")).run(
    sortIdx,
    event.id,
  );
}

/**
 * Set `entities.sort_idx` for a forward-reference entity created by a
 * `forwardMessages` event, by copying the original message's sort_idx.
 *
 * Without this the forward-reference entity has sort_idx = NULL and
 * selectMessages falls back to ordering by the forward event's own ULID. A
 * thread-creation batch forwards several messages within the same
 * millisecond, so those ULIDs differ only in their random suffixes and the
 * original chronological order of the forwarded messages is scrambled (older
 * forwarded messages can end up displayed after newer ones).
 *
 * Copying the original's sort_idx places the forwarded copy at the same
 * chronological position as the original, which is also consistent with the
 * displayed timestamp (selectMessages substitutes the original's timestamp
 * and content for the forwarded copy). No-op if the original isn't
 * materialised yet (the forward edge was skipped — see the guarded insert in
 * the SDK materialiser) or has no sort_idx. forwardMessages is currently
 * capped at one message per event.
 */
export async function setMessageSortIdxByForward(db: DbLike, event: Event): Promise<void> {
  if (event.$type !== "space.roomy.message.forwardMessages.v0") return;
  if (!("messageIds" in event) || !Array.isArray(event.messageIds)) return;

  const originalId = event.messageIds[0] as Ulid | undefined;
  if (!originalId) return;

  const orig = await db
    .query("select sort_idx from entities where id = ?")
    .get<{ sort_idx: string | null }>(originalId);

  if (!orig || !orig.sort_idx) return;

  await (await db.prepare("update entities set sort_idx = ? where id = ?")).run(
    orig.sort_idx,
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
    console.warn(
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
    console.warn(
      `[materialize] reorderMessage: could not compute midpoint for ${messageId}:`,
      e,
    );
    return;
  }

  await (await db.prepare("update entities set sort_idx = ? where id = ?")).run(
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
