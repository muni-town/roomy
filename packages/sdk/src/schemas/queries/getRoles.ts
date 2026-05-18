/**
 * Schema for `space.roomy.space.getRoles` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getRoles.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getRoles" as const;

export const Params = type({ spaceId: "string" });

export const RoleRoom = type({
  roomId: "string",
  permission: "'read' | 'readwrite'",
});

export const Role = type({
  id: "string",
  name: "string | null",
  avatar: "string | null",
  description: "string | null",
  rooms: RoleRoom.array(),
  memberDids: "string[]",
});

export const Response = type({
  roles: Role.array(),
});
