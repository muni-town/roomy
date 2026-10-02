/**
 * Schema for `space.roomy.voice.leave` (procedure).
 * Source of truth: packages/appserver/src/handlers/space.roomy.voice.leave.ts
 *
 * Records the caller's leave intent. When the departing participant is the
 * last one, the call ends — the same reconciliation rule the LiveKit webhook
 * applies, so the projection does not depend on which path got there first.
 *
 * Returns void; the resulting participant list arrives over the sync socket
 * as a `#voicePresenceDiff`.
 */
import { type } from "arktype";

export const NSID = "space.roomy.voice.leave" as const;

export const Input = type({ roomId: "string" });

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});
