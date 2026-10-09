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

export const ActiveThreadMember = type({
  did: "string",
  "name?": "string | null",
  "avatar?": "string | null",
});

export const ThreadActivity = type({
  "latestTimestamp?": "string | null",
  latestMembers: ActiveThreadMember.array(),
});

export const ActiveSidebarThread = type({
  id: "string",
  "name?": "string",
  activity: ThreadActivity,
  canRead: "boolean",
  canWrite: "boolean",
  unreadCount: "number",
  "lastRead?": "string | null",
});

export const FederatedChannel = type({
  originSpaceId: "string",
  "originSpaceName?": "string",
  "originSpaceAvatar?": "string",
  permission: "'read' | 'readwrite'",
});

export const SidebarChannel = type({
  id: "string",
  "name?": "string",
  defaultAccess: "'readwrite' | 'read' | 'none'",
  canRead: "boolean",
  canWrite: "boolean",
  unreadCount: "number",
  "lastRead?": "string",
  "activeThreads?": ActiveSidebarThread.array(),
  "federated?": FederatedChannel,
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
  "handle?": "string",
  joinPolicy: JoinPolicy,
  /**
   * Whether the space may be suggested to other users. The key is absent when
   * an admin has not answered (which reads as yes); `false` is an explicit
   * opt-out. Storage keeps the unanswered state as NULL rather than
   * collapsing it to a value, so a client can tell a defaulted space from an
   * answered one.
   */
  "suggestToOthers?": "boolean",
  isMember: "boolean",
  isAdmin: "boolean",
  /** Number of channels with unread messages (sidebar-visible rooms only). */
  unreadRoomCount: "number",
  /** Number of engaged threads with unread messages. */
  unreadThreadCount: "number",
  /** Voice rooms the caller can read — placed by id, not by category. */
  voiceRooms: SidebarChannel.array(),
  sidebar: {
    categories: SidebarCategory.array(),
    orphans: SidebarChannel.array(),
  },
  "deletedRooms?": DeletedRoom.array(),
});