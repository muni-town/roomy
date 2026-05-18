/**
 * Hardcoded message-diff applicator.
 *
 * Per Slice 6 of the SDK thin-client extraction plan, diff applicators live
 * directly in the SDK rather than in a pluggable registry — we have one
 * diffable surface today (messages); generalising can wait until a second
 * one appears.
 *
 * `applyMessageDiff` must tolerate `undefined` as `prev` because the
 * `#messageDiff` stream can race ahead of the initial `getMessages` fetch
 * (per commit `749992c1`). When there is no existing cached list, we
 * construct one from the diff's `add`/`update` ops (skipping `remove`s
 * with no target).
 */
import { Message as MessageSchema } from "../schemas/queries/_message";
import { Op as OpSchema } from "../schemas/frames/messageDiff";

export type Message = typeof MessageSchema.infer;
export type MessageDiffOp = typeof OpSchema.infer;

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
  return [...map.values()].sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}
