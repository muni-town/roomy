/**
 * Schema for `space.roomy.space.getMetadata` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getMetadata.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getMetadata" as const;

export const Params = type({ spaceId: "string", "includeDeleted?": "string" });

export const DeletedRoom = type({
  id: "string",
  "name?": "string",
});

export const SidebarChannel = type({
  id: "string",
  "name?": "string",
  defaultAccess: "'readwrite' | 'read' | 'none'",
  canRead: "boolean",
  canWrite: "boolean",
  unreadCount: "number",
  "lastRead?": "string",
});

export const SidebarCategory = type({
  "id?": "string",
  name: "string",
  position: "number",
  channels: SidebarChannel.array(),
});

export const JoinPolicy = type({
  allowPublicJoin: "boolean",
  allowMemberInvites: "boolean",
});

export const Response = type({
  "name?": "string",
  "avatar?": "string",
  "description?": "string",
  joinPolicy: JoinPolicy,
  isMember: "boolean",
  isAdmin: "boolean",
  sidebar: {
    categories: SidebarCategory.array(),
    orphans: SidebarChannel.array(),
  },
  "deletedRooms?": DeletedRoom.array(),
});
