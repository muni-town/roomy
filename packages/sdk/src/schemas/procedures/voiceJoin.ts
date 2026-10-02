/**
 * Schema for `space.roomy.voice.join` (procedure).
 * Source of truth: packages/appserver/src/handlers/space.roomy.voice.join.ts
 *
 * Records the caller's join intent as a durable call fact before the client
 * connects to LiveKit, so the participant list is optimistic and survives a
 * failed media connection. The LiveKit webhook later confirms the same
 * transition; the duplicate is collapsed, not appended twice.
 *
 * When the room has no active call this starts one. Returns void: the client
 * learns the resulting callId from `space.roomy.voice.getToken`.
 */
import { type } from "arktype";

export const NSID = "space.roomy.voice.join" as const;

export const Input = type({ roomId: "string" });

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});
