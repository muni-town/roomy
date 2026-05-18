/**
 * Schema for `space.roomy.room.updateSeen` (procedure).
 * Source of truth: packages/appserver/src/handlers/space.roomy.room.updateSeen.ts
 *
 * Returns no body — the handler is `ProcedureHandler<UpdateSeenBody, void>`.
 * The router short-circuits void outputs (commit b57ad1ca), so the wire
 * response is empty. We model `Output` as the empty object for parity with
 * how the existing wrappers see it.
 */
import { type } from "arktype";

export const NSID = "space.roomy.room.updateSeen" as const;

export const Input = type({
  roomId: "string",
  "seenUpTo?": "string",
});

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});
