/**
 * Schema for `space.roomy.space.getMembers` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getMembers.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getMembers" as const;

export const Params = type({ spaceId: "string" });
export type Params = typeof Params.infer;

export const Member = type({
  did: "string",
  handle: "string | null",
  name: "string | null",
  avatar: "string | null",
  isAdmin: "boolean",
  roleIds: "string[]",
});
export type Member = typeof Member.infer;

export const ExternalAdmin = type({
  did: "string",
  handle: "string | null",
  name: "string | null",
  avatar: "string | null",
});
export type ExternalAdmin = typeof ExternalAdmin.infer;

export const Response = type({
  members: Member.array(),
  externalAdmins: ExternalAdmin.array(),
});
export type Response = typeof Response.infer;
