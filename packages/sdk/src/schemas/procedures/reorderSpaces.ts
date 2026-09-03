/**
 * Schema for `space.roomy.space.reorderSpaces` (procedure).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.reorderSpaces.ts
 *
 * Reorders the caller's space list. The client sends the full ordered list
 * of joined space DIDs; the appserver stores it per-user in the read-state
 * DB (not the ATProto event stream).
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.reorderSpaces" as const;

export const Input = type({
  /** The caller's joined space DIDs, in the desired list order. */
  spaceIds: "string[]",
});

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});
