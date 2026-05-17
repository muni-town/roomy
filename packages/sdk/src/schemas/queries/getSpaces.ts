/**
 * Schema for `space.roomy.space.getSpaces` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getSpaces.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getSpaces" as const;

/** No params. */
export const Params = type({});
export type Params = typeof Params.infer;

export const Space = type({
  id: "string",
  name: "string | null",
  avatar: "string | null",
  description: "string | null",
  unreadCount: "number",
  isMember: "boolean",
  isAdmin: "boolean",
  roleIds: "string[]",
});
export type Space = typeof Space.infer;

export const Response = type({
  spaces: Space.array(),
});
export type Response = typeof Response.infer;
