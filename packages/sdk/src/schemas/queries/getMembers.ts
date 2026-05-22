/**
 * Schema for `space.roomy.space.getMembers` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getMembers.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getMembers" as const;

export const Params = type({ spaceId: "string" });

export const Member = type({
  did: "string",
  "handle?": "string",
  "name?": "string",
  "avatar?": "string",
  isAdmin: "boolean",
  roleIds: "string[]",
});

export const ExternalAdmin = type({
  did: "string",
  "handle?": "string",
  "name?": "string",
  "avatar?": "string",
});

export const Response = type({
  members: Member.array(),
  externalAdmins: ExternalAdmin.array(),
});
