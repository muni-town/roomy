/**
 * Schema for `space.roomy.space.getRoles` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getRoles.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getRoles" as const;

export const Params = type({ spaceId: "string" });
export type Params = typeof Params.infer;

export const RoleRoom = type({
  roomId: "string",
  permission: "'read' | 'readwrite'",
});
export type RoleRoom = typeof RoleRoom.infer;

export const Role = type({
  id: "string",
  name: "string | null",
  avatar: "string | null",
  description: "string | null",
  rooms: RoleRoom.array(),
  memberDids: "string[]",
});
export type Role = typeof Role.infer;

export const Response = type({
  roles: Role.array(),
});
export type Response = typeof Response.infer;
