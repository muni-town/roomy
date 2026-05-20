/**
 * Schema for `space.roomy.space.sendEvents` (procedure).
 * Source of truth: packages/appserver/docs/plans/sendEvents-procedure.md
 *
 * Sends a batch of Roomy events to a space stream through the appserver.
 * The appserver validates authorization per-event, then proxies the batch
 * to Leaf with `userOverride` set to the caller's DID.
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.sendEvents" as const;

export const Input = type({
  spaceId: "string",
  events: type.object.array().moreThanLength(0).atMostLength(50),
});

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});
