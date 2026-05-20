/**
 * Schema for `space.roomy.space.leaveSpace` (procedure).
 * Source of truth: packages/appserver/docs/plans/procedure-backlog.md
 *
 * Appends the space-side leave event AND the personal-space leave event
 * server-side, so every client leaves a space consistently regardless of
 * whether it tracks the personal space.
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.leaveSpace" as const;

export const Input = type({
  spaceId: "string",
});

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});
