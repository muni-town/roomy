/**
 * Hardcoded message-diff applicator.
 *
 * Diff applicators live directly in the SDK rather than in a pluggable
 * registry — messages are the only diffable surface.
 *
 * `applyMessageDiff` must tolerate `undefined` as `prev` because the
 * `#messageDiff` stream can race ahead of the initial `getMessages` fetch.
 * When there is no existing cached list, we construct one from the diff's
 * `add`/`update` ops (skipping `remove`s with no target).
 */
import { Message as MessageSchema } from "../schemas/queries/_message";
import { Op as OpSchema } from "../schemas/frames/messageDiff";

export type Message = typeof MessageSchema.infer;
export type MessageDiffOp = typeof OpSchema.infer;

/**
 * The key the timeline is ordered by, matching `selectMessages` exactly:
 * `sort_idx` with the id as the fallback and tie-break.
 *
 * `sort_idx` is the server's ordering key. `timestamp` is NOT a substitute —
 * it is the time the message body claims, which for a `createMessage` is
 * whatever the sending device's clock said, the very thing the key exists to
 * stop mattering. Sorting a diff by it re-orders live arrivals against the
 * page the server returned and puts a skewed client's message wherever its
 * clock claims. A message the server has not sorted (a system message) has no
 * `sort_idx`, and falls back to its id exactly as the server does.
 *
 * Ascending, both terms. The cache holds a timeline oldest-first, so this is
 * the order every writer of a `getMessages` list must agree on: the diff
 * applicator below, the room read path's merge (`queries/messages.ts`), and
 * the restore validator (`cache/restore.ts`), which re-sorts what it loads
 * with this same function rather than trusting the order it was given.
 */
export function compareTimelineOrder(a: Message, b: Message): number {
  const byKey = (a.sort_idx ?? a.id).localeCompare(b.sort_idx ?? b.id);
  return byKey !== 0 ? byKey : a.id.localeCompare(b.id);
}
export function applyMessageDiff(
  prev: Message[] | undefined,
  ops: readonly MessageDiffOp[],
): Message[] {
  const map = new Map<string, Message>(
    (prev ?? []).map((m) => [m.id, m]),
  );
  for (const op of ops) {
    if (op.op === "add" && op.message) {
      map.set(op.key, op.message);
    } else if (op.op === "update" && op.message) {
      const existing = map.get(op.key);
      map.set(op.key, existing ? { ...existing, ...op.message } : op.message);
    } else if (op.op === "remove") {
      map.delete(op.key);
    }
  }
  return [...map.values()].sort(compareTimelineOrder);
}
