/**
 * Sort-index materialisation for messages.
 *
 * `entities.sort_idx` is the server's timeline key: `selectMessages` pages by
 * it, and the client re-sorts a room by it. It is a 26-character ULID-shaped
 * string, so `decodeTime` still reads its time component and every
 * `sort_idx > ?` comparison keeps working.
 *
 * The key is `time + log position`: the first 10 characters encode the
 * message's ORDERING TIME, the last 16 encode the index of the event that
 * wrote it. Two properties follow, and both are load-bearing:
 *
 *  - ORDERING TIME is the message's canonical time — a `timestampOverride`
 *    extension when a producer translating another timeline set one (the
 *    Discord bridge), otherwise the instant this server accepted the event
 *    (`stream_events.received_at`, recorded once at append). A `createMessage`
 *    id is a ULID the sender's device minted, so keying the timeline on it
 *    would let one skewed clock bury a message mid-history for every other
 *    client, durably — the key is written once and never repaired.
 *  - LOG POSITION is the tie-break, replacing a random ULID suffix. Messages
 *    that share an ordering time (a burst inside one millisecond, a replayed
 *    batch) then order identically in every derivation of the same log.
 *
 * Together they make the key a pure function of the log: the same events
 * materialised twice, at different times or on different processes, produce
 * the same key. Kept *outside* the SDK materialisers, which are kept
 * backfill-agnostic and free of extension-aware ordering logic.
 */

import type { DbLike } from "../db/types.ts";
import { decodeTime, encodeTime } from "ulidx";
import type { Event, StreamDid, StreamIndex, Ulid } from "@roomy-space/sdk";
import { log } from "../log.ts";

/** Characters of a sort key spent on the time component (a ULID's time width). */
const TIME_LEN = 10;
/** Characters of a sort key spent on the log position (a ULID's random width). */
const POSITION_LEN = 16;
/** Crockford base32, the encoding both halves of a sort key use. */
const B32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Base32 of a non-negative integer, left-padded to `len` characters. Fixed
 * width, so lexicographic order is numeric order.
 */
function encodeBase32(value: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out = B32_ALPHABET[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

/**
 * A sort key whose position half lies strictly between the two given halves,
 * without decoding either. Each prefix is the upper bound its suffix must stay
 * below, so the first character the two disagree on decides it: take the lower
 * key's prefix including that character and append zeros, which is greater
 * than the lower key (a longer nonzero tail) and less than the upper (a smaller
 * character at the deciding position).
 *
 * Callers only reach here with keys that differ, and the two keys are the
 * bounds of a gap, so a deciding character always exists.
 */
function betweenBase32(lower: string, upper: string): string {
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] !== upper[i]) {
      return lower.slice(0, i + 1) + "0".repeat(lower.length - i - 1);
    }
  }
  throw new Error(`Sort keys are equal: ${lower}`);
}

/**
 * Build a sort key from an ordering time and the index of the event that
 * produced it.
 */
export function orderKey(timeMs: number, idx: number): Ulid {
  return (encodeTime(timeMs, TIME_LEN) + encodeBase32(idx, POSITION_LEN)) as Ulid;
}

/**
 * The instant a message is ordered by, in precedence order:
 *
 *  1. a `timestampOverride` extension — the true order of another system's
 *     timeline (the Discord bridge stamps the original Discord send time);
 *  2. the log's server-observed receipt (`stream_events.received_at`), which
 *     is the rule: it keeps a skewed sender clock from burying a message, and
 *     recording it once at append is what lets a rebuild reproduce the same key
 *     instead of re-deciding it;
 *  3. the log's ingest time (`stream_events.created_at`) — the same observation
 *     at second resolution, for a row whose append never stamped a receipt;
 *  4. the event's own ULID time — the sender's clock, and the only value left
 *     for a row that carries no server observation at all.
 */
export function messageOrderTime(
  event: Event,
  receivedAt?: number | null,
  createdAt?: number | null,
): number {
  if (event.$type === "space.roomy.message.createMessage.v0") {
    const override =
      event.extensions?.["space.roomy.extension.timestampOverride.v0"];
    if (override) return Number(override.timestamp);
  }
  return receivedAt ?? createdAt ?? decodeTime(event.id);
}

/**
 * The sort key a message event's entity should carry: its ordering time,
 * tie-broken by the event's log position.
 *
 * `idx` is what makes a same-millisecond burst deterministic. Without it two
 * messages stamped with one timestamp would sort by a random suffix — a
 * different order in every derivation, and an unstable one across the page
 * boundary the cursor walks.
 */
export function messageSortIdxKey(
  event: Event,
  idx: StreamIndex | number,
  receivedAt?: number | null,
  createdAt?: number | null,
): Ulid {
  return orderKey(messageOrderTime(event, receivedAt, createdAt), idx);
}

/**
 * Set `entities.sort_idx` for a freshly-created message.
 *
 * No-op if the entity row is missing (materialiser failed earlier in the
 * batch) or if a sort_idx is already set — a message is keyed once, by the
 * event that created it.
 */
export async function setMessageSortIdxByTimestamp(
  db: DbLike,
  event: Event,
  idx: StreamIndex | number,
  receivedAt?: number | null,
  createdAt?: number | null,
): Promise<void> {
  if (event.$type !== "space.roomy.message.createMessage.v0") return;

  const sortIdx = messageSortIdxKey(event, idx, receivedAt, createdAt);
  // No SELECT needed: the entity was just created by ensureEntity in the same
  // savepoint with sort_idx = NULL. If the row is missing or sort_idx is
  // already set, this UPDATE is a no-op.
  await db.run("update entities set sort_idx = ? where id = ? and sort_idx is null", sortIdx, event.id);
}

/**
 * Set `entities.sort_idx` for a forward-reference entity created by a
 * `forwardMessages` event, using the forward's ordering time — it is new
 * content arriving now, so it belongs at the top of the destination.
 *
 * The forwarded original stays where it is; the forward-reference entity is a
 * new row in the destination room, so it is ordered like a new message — at
 * the top of that room's timeline, matching the forward-as-embed
 * representation (createMessage + forward attachment). Copying the original
 * message's sort_idx here instead would place a forward of an old message deep
 * in history — outside the first getMessages page — so it would flash in via
 * the WS diff and vanish on the next refetch.
 *
 * No-op if the entity row is missing (materialiser failed earlier in the
 * batch) or if a sort_idx is already set.
 */
export async function setMessageSortIdxByForward(
  db: DbLike,
  event: Event,
  idx: StreamIndex | number,
  receivedAt?: number | null,
  createdAt?: number | null,
): Promise<void> {
  if (event.$type !== "space.roomy.message.forwardMessages.v0") return;

  const sortIdx = orderKey(messageOrderTime(event, receivedAt, createdAt), idx);
  await db.run(
    "update entities set sort_idx = ? where id = ? and sort_idx is null",
    sortIdx,
    event.id,
  );
}

/**
 * Set `entities.sort_idx` for messages moved by a `moveMessages` event.
 *
 * Ordering policy — a moved message sorts at the TOP of the destination
 * room's timeline, keyed by the move event's ordering time. Why: `sort_idx` is
 * the server's page-selection key (`selectMessages` orders by it and takes the
 * newest `limit` rows — room.getMessages.ts). A moved message that kept its
 * original `sort_idx` would be buried according to its ORIGINAL send time, so
 * moving an old message into a busy channel would put it outside the
 * newest-50 page: it would flash into connected clients via the WS `add` diff
 * and vanish on the next refetch. That is the same reasoning
 * `setMessageSortIdxByForward` above applies to a forward of an old message.
 *
 * `comp_content.timestamp` is deliberately NOT rewritten: the message's
 * original send time is its identity, and the client renders timestamps from
 * `timestamp`. Ordering does not depend on it — the client re-sorts the
 * timeline by `sort_idx` (see the SDK's `applyMessageDiff`), which is the same
 * key this write changes.
 *
 * Only messages that actually exist are touched (a move of an unmaterialised
 * id is a no-op), and the update is unconditional: unlike create/forward,
 * which use `and sort_idx is null`, a moved message already HAS a sort_idx and
 * the move must overwrite it.
 */
export async function setMessageSortIdxByMove(
  db: DbLike,
  event: Event,
  idx: StreamIndex | number,
  receivedAt?: number | null,
  createdAt?: number | null,
): Promise<void> {
  if (event.$type !== "space.roomy.message.moveMessages.v0") return;

  const sortIdx = orderKey(messageOrderTime(event, receivedAt, createdAt), idx);
  for (const messageId of event.messageIds) {
    await db.run(
      "update entities set sort_idx = ? where id = ? and room = ?",
      sortIdx,
      messageId,
      event.toRoomId,
    );
  }
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
  // exists.

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
    sortIdx = midpointSortKey(
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
 * A sort key lexicographically between two others — deterministic, so
 * replaying a reorder lands the message where it landed live.
 *
 * Between two keys in different milliseconds the time halves average and the
 * position half is zeroed (nothing in the gap needs a tie-break). Within one
 * millisecond the time halves are equal and the position halves are split.
 * When `later` is missing the entry sorts 10 ms after `earlier`.
 */
function midpointSortKey(earlier: Ulid, later?: Ulid): string {
  const e = decodeTime(earlier);
  if (!later) return orderKey(e + 10, 0);

  const l = decodeTime(later);
  if (e !== l) return orderKey(Math.floor((e + l) / 2), 0);

  const eStr = earlier as string;
  const lStr = later as string;
  const ePos = eStr.slice(TIME_LEN);
  const lPos = lStr.slice(TIME_LEN);
  if (ePos === lPos) throw new Error(`Sort keys are equal: ${earlier}`);
  return eStr.slice(0, TIME_LEN) + betweenBase32(ePos, lPos);
}

/**
 * Canonical time (ms since epoch) of a message event: the `timestampOverride`
 * extension when present (Discord-bridged messages carry the original Discord
 * send time), else the event's own ULID time.
 *
 * Callers use this as a DISPLAY/identity timestamp — the activity feed's
 * ordering, the push freshness gate — not as the timeline key; that is
 * `messageOrderTime`, which prefers the server's receipt over the sender's
 * ULID. The two differ for a live message, whose ULID encodes the sender's
 * clock while its place in the timeline follows this server's receipt.
 */
export function canonicalMessageTimestamp(event: Event): number {
  return messageOrderTime(event);
}
