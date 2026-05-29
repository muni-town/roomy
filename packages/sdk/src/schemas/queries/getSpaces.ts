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
  unreadCount: "number",
  isMember: "boolean",
  isAdmin: "boolean",
  roleIds: "string[]",
});

export const Response = type({
  spaces: Space.array(),
});
