/**
 * Schema for `space.roomy.space.getMetadata` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getMetadata.ts
 *
 * Note: appserver returns `SidebarChannel.name: string | null` and
 * `SidebarCategory.id: string | null` (v0 categories have no stable id), while
 * the playground's hand-authored types declared both as non-null. We follow
 * the appserver shape.
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getMetadata" as const;

export const Params = type({ spaceId: "string" });

export const SidebarChannel = type({
  id: "string",
  name: "string | null",
  defaultAccess: "'readwrite' | 'read' | 'none'",
  canRead: "boolean",
  canWrite: "boolean",
  unreadCount: "number",
  lastRead: "string | null",
});

export const SidebarCategory = type({
  id: "string | null",
  name: "string",
  position: "number",
  channels: SidebarChannel.array(),
});

export const JoinPolicy = type({
  allowPublicJoin: "boolean",
  allowMemberInvites: "boolean",
});

export const Response = type({
  name: "string | null",
  avatar: "string | null",
  description: "string | null",
  joinPolicy: JoinPolicy,
  isMember: "boolean",
  isAdmin: "boolean",
  sidebar: {
    categories: SidebarCategory.array(),
    orphans: SidebarChannel.array(),
  },
});
