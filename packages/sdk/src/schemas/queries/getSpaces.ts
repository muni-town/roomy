/**
 * Schema for `space.roomy.space.getSpaces` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getSpaces.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getSpaces" as const;

/** Params. `includeLeft` — when "true", also includes spaces the user has left. */
export const Params = type({
  "includeLeft?": "string",
});

export const Space = type({
  id: "string",
  "name?": "string",
  "avatar?": "string",
  "description?": "string",
  "handle?": "string",
  /**
   * Whether any room of this space has unread messages for the caller.
   * A level, not a count: the unread badges the caller sees are the sidebar's
   * per-room counts, and the space list only needs to know whether to mark
   * the space at all.
   */
  hasUnreads: "boolean",
  isMember: "boolean",
  isAdmin: "boolean",
  roleIds: "string[]",
});

export const Response = type({
  spaces: Space.array(),
});
