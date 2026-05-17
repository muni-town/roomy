/**
 * Schema for `space.roomy.space.getInvites` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getInvites.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getInvites" as const;

export const Params = type({ spaceId: "string" });
export type Params = typeof Params.infer;

export const Invite = type({
  token: "string",
  createdBy: "string",
  eventUlid: "string",
});
export type Invite = typeof Invite.infer;

export const Response = type({
  invites: Invite.array(),
});
export type Response = typeof Response.infer;
