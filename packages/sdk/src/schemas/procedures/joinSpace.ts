/**
 * Schema for `space.roomy.space.joinSpace` (procedure).
 * Source of truth: packages/appserver/docs/plans/procedure-backlog.md
 *
 * Validates invite tokens for private spaces, appends the space-side join
 * event AND the personal-space join event in a single call, so every client
 * joins a space consistently.
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.joinSpace" as const;

export const Input = type({
  spaceId: "string",
  "inviteToken?": "string",
});

export const Output = type({
  spaceId: "string",
});
