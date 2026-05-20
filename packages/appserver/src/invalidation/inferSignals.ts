/**
 * Pure function mapping an applied Leaf event → invalidation signals.
 *
 * This is the single source of truth for "what query results changed when
 * event X fires". Both the WS handler and the server-side cache consume
 * signals produced here.
 *
 * Design principle: when in doubt, over-invalidate. A spurious re-fetch is
 * cheap; stale data is a bug. We can tighten signals later based on
 * observability.
 *
 * Each event type is handled by a dedicated function. The main `inferSignals`
 * entry point dispatches by `$type`.
 */

import type { StreamDid, Ulid, UserDid } from "@roomy-space/sdk";
import type { AppliedEvent, InvalidationEvent, QueryNsid } from "./types.ts";
import { openDb } from "../db/db.ts";

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Infer invalidation signals for a single applied event.
 * Returns an array (can be empty for events that don't affect query results,
 * e.g. synthetic backfill events).
 */
export function inferSignals(event: AppliedEvent): InvalidationEvent[] {
  // Suppress signals for synthetic query events — they're bulk hydration,
  // not incremental changes.
  if (event.type.startsWith("space.roomy.query.")) return [];

  const handler = HANDLERS[event.type as keyof typeof HANDLERS];
  if (!handler) return [];
  return handler(event);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function invalidate(
  nsid: QueryNsid,
  params: Record<string, string>,
  affectedUser?: UserDid,
): InvalidationEvent {
  return {
    kind: "queryInvalidation",
    signal: { nsid, params, affectedUser },
  };
}

function invalidateSpace(spaceId: StreamDid): InvalidationEvent[] {
  return [
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
    invalidate("space.roomy.space.getThreads", { spaceId }),
    invalidate("space.roomy.space.getMembers", { spaceId }),
  ];
}

function invalidateRoom(roomId: Ulid, spaceId: StreamDid): InvalidationEvent[] {
  return [
    invalidate("space.roomy.room.getMetadata", { roomId }),
    invalidate("space.roomy.room.getThreads", { roomId }),
    // Space sidebar may show unread counts for this room.
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
  ];
}

// ─── Message events ─────────────────────────────────────────────────────

function handleCreateMessage(event: AppliedEvent): InvalidationEvent[] {
  const roomId = event.roomId;
  if (!roomId) return [];

  const spaceId = event.streamDid;
  const details = event.details ?? {};

  // Resolve author profile from materialized DB.
  // By this point the event has been applied to SQLite, so the author
  // edge and comp_info row exist.
  const authorDid = (details.authorDid as UserDid | undefined) ?? event.user;
  const authorProfile = resolveProfile(authorDid);

  // Resolve message content from materialized DB.
  const content = resolveContent(event.id);

  const signals: InvalidationEvent[] = [
    // Message diff — applied directly to WS client cache, no HTTP re-fetch.
    {
      kind: "messageDiff",
      signal: {
        roomId,
        seq: (details.seq as number) ?? 0,
        ops: [
          {
            op: "add",
            key: event.id,
            message: {
              id: event.id,
              content,
              authorDid,
              authorName: authorProfile.name,
              authorAvatar: authorProfile.avatar,
              timestamp:
                (details.timestamp as string) ?? new Date().toISOString(),
              replyTo: resolveReplyTo(event.id),
              reactions: [],
            },
          },
        ],
      },
    },
    // Room metadata may update (unread count, recentThreads).
    // Sidebar may update (unread count on the channel).
    ...invalidateRoom(roomId, spaceId),
  ];

  return signals;
}

function handleEditMessage(event: AppliedEvent): InvalidationEvent[] {
  const roomId = event.roomId;
  if (!roomId) return [];

  const details = event.details ?? {};
  const authorDid =
    (details.authorDid as UserDid | undefined) ?? event.user;
  const authorProfile = resolveProfile(authorDid);
  const content = resolveContent(event.id);
  const reactions = resolveReactions(event.id);

  return [
    {
      kind: "messageDiff",
      signal: {
        roomId,
        seq: (details.seq as number) ?? 0,
        ops: [
          {
            op: "update",
            key: event.id,
            message: {
              id: event.id,
              content,
              authorDid,
              authorName: authorProfile.name,
              authorAvatar: authorProfile.avatar,
              timestamp:
                (details.timestamp as string) ?? new Date().toISOString(),
              replyTo: resolveReplyTo(event.id),
              reactions,
            },
          },
        ],
      },
    },
    // Edit doesn't change unread count, but room metadata's recentThreads
    // might reference this message's activity.
    invalidate("space.roomy.room.getMetadata", { roomId }),
  ];
}

function handleDeleteMessage(event: AppliedEvent): InvalidationEvent[] {
  const roomId = event.roomId;
  if (!roomId) return [];

  const details = event.details ?? {};

  return [
    {
      kind: "messageDiff",
      signal: {
        roomId,
        seq: (details.seq as number) ?? 0,
        ops: [{ op: "remove", key: event.id }],
      },
    },
    ...invalidateRoom(roomId, event.streamDid),
  ];
}

// ─── Reaction events ────────────────────────────────────────────────────

function handleReactionChange(event: AppliedEvent): InvalidationEvent[] {
  const roomId = event.roomId;
  if (!roomId) return [];

  const details = event.details ?? {};

  return [
    invalidate("space.roomy.room.getMessages", { roomId }),
    ...(details.messageId
      ? [
          invalidate("space.roomy.message.getMessage", {
            messageId: details.messageId as string,
          }),
        ]
      : []),
  ];
}

// ─── Room events ────────────────────────────────────────────────────────

function handleCreateRoom(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [
    ...invalidateSpace(spaceId),
    // New room means sidebar changed.
    invalidate("space.roomy.space.getMetadata", { spaceId }),
  ];
}

function handleUpdateRoom(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const roomId = (details.roomId as Ulid | undefined) ?? event.roomId;

  const signals: InvalidationEvent[] = [
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
  ];

  if (roomId) {
    signals.push(...invalidateRoom(roomId, spaceId));
  }

  return signals;
}

function handleDeleteRoom(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const roomId = (details.roomId as Ulid | undefined) ?? event.roomId;

  const signals: InvalidationEvent[] = [...invalidateSpace(spaceId)];
  if (roomId) {
    signals.push(invalidate("space.roomy.room.getMetadata", { roomId }));
  }
  return signals;
}

function handleRestoreRoom(event: AppliedEvent): InvalidationEvent[] {
  return handleCreateRoom(event);
}

// ─── Space events ───────────────────────────────────────────────────────

function handleUpdateSpaceInfo(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
  ];
}

function handleUpdateSidebar(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [invalidate("space.roomy.space.getMetadata", { spaceId })];
}

function handleJoinSpace(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [
    ...invalidateSpace(spaceId),
    invalidate("space.roomy.space.getSpaces", {}, event.user),
  ];
}

function handleLeaveSpace(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [
    ...invalidateSpace(spaceId),
    invalidate("space.roomy.space.getSpaces", {}, event.user),
  ];
}

function handleAddAdmin(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const targetUser = details.userDid as UserDid | undefined;

  return [
    ...invalidateSpace(spaceId),
    ...(targetUser
      ? [
          invalidate("space.roomy.space.getSpaces", {}, targetUser),
          invalidate("space.roomy.space.getMetadata", { spaceId }, targetUser),
          invalidate("space.roomy.space.getMembers", { spaceId }),
        ]
      : []),
  ];
}

function handleRemoveAdmin(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const targetUser = details.userDid as UserDid | undefined;

  return [
    ...invalidateSpace(spaceId),
    ...(targetUser
      ? [
          invalidate("space.roomy.space.getSpaces", {}, targetUser),
          invalidate("space.roomy.space.getMetadata", { spaceId }, targetUser),
          invalidate("space.roomy.space.getMembers", { spaceId }),
        ]
      : []),
  ];
}

function handleBanAccount(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const targetUser = details.userDid as UserDid | undefined;

  return [
    ...invalidateSpace(spaceId),
    ...(targetUser
      ? [invalidate("space.roomy.space.getSpaces", {}, targetUser)]
      : []),
  ];
}

function handleUnbanAccount(event: AppliedEvent): InvalidationEvent[] {
  return handleBanAccount(event);
}

// ─── Personal stream events ─────────────────────────────────────────────

function handlePersonalJoinSpace(event: AppliedEvent): InvalidationEvent[] {
  const details = event.details ?? {};
  const spaceId = details.spaceDid as StreamDid | undefined;
  const signals: InvalidationEvent[] = [
    invalidate("space.roomy.space.getSpaces", {}, event.user),
  ];
  if (spaceId) {
    signals.push(
      invalidate("space.roomy.space.getMembers", { spaceId }),
      invalidate("space.roomy.space.getMetadata", { spaceId }),
    );
  }
  return signals;
}

function handlePersonalLeaveSpace(event: AppliedEvent): InvalidationEvent[] {
  const details = event.details ?? {};
  const spaceId = details.spaceDid as StreamDid | undefined;
  const signals: InvalidationEvent[] = [
    invalidate("space.roomy.space.getSpaces", {}, event.user),
  ];
  if (spaceId) {
    signals.push(invalidate("space.roomy.space.getMembers", { spaceId }));
  }
  return signals;
}

// ─── Link events ────────────────────────────────────────────────────────

function handleCreateRoomLink(event: AppliedEvent): InvalidationEvent[] {
  const roomId = event.roomId;
  const spaceId = event.streamDid;
  if (!roomId) return [];
  return [
    ...invalidateRoom(roomId, spaceId),
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getThreads", { spaceId }),
  ];
}

function handleRemoveRoomLink(event: AppliedEvent): InvalidationEvent[] {
  return handleCreateRoomLink(event);
}

// ─── Role events ────────────────────────────────────────────────────────

function handleCreateRole(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [invalidate("space.roomy.space.getRoles", { spaceId })];
}

function handleDeleteRole(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [
    invalidate("space.roomy.space.getRoles", { spaceId }),
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
  ];
}

function handleUpdateRole(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [invalidate("space.roomy.space.getRoles", { spaceId })];
}

function handleAddMemberRole(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const targetUser = details.userDid as UserDid | undefined;

  return [
    invalidate("space.roomy.space.getRoles", { spaceId }),
    invalidate("space.roomy.space.getMembers", { spaceId }),
    ...(targetUser
      ? [
          invalidate("space.roomy.space.getSpaces", {}, targetUser),
          invalidate("space.roomy.space.getMetadata", { spaceId }, targetUser),
        ]
      : []),
  ];
}

function handleRemoveMemberRole(event: AppliedEvent): InvalidationEvent[] {
  return handleAddMemberRole(event);
}

function handleSetRoleRoomPermission(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const roomId = details.roomId as Ulid | undefined;

  const signals: InvalidationEvent[] = [
    invalidate("space.roomy.space.getRoles", { spaceId }),
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
  ];

  if (roomId) {
    signals.push(...invalidateRoom(roomId, spaceId));
  }

  return signals;
}

// ─── Invite events ──────────────────────────────────────────────────────

function handleCreateInvite(event: AppliedEvent): InvalidationEvent[] {
  return [
    invalidate("space.roomy.space.getInvites", { spaceId: event.streamDid }),
  ];
}

function handleRevokeInvite(event: AppliedEvent): InvalidationEvent[] {
  return handleCreateInvite(event);
}

// ─── User / profile events ──────────────────────────────────────────────

function handleUpdateProfile(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  // Profile update in a space affects member display names/avatars.
  return [invalidate("space.roomy.space.getMembers", { spaceId })];
}

// ─── State events ───────────────────────────────────────────────────────

function handleMarkRead(event: AppliedEvent): InvalidationEvent[] {
  const roomId = event.roomId;
  if (!roomId) return [];
  const spaceId = event.streamDid;

  return [
    invalidate("space.roomy.room.getMetadata", { roomId }, event.user),
    invalidate("space.roomy.space.getMetadata", { spaceId }, event.user),
    invalidate("space.roomy.space.getSpaces", {}, event.user),
  ];
}

// ─── DB lookups for message diff hydration ────────────────────────────
//
// By the time inferSignals runs, the event has been materialized to SQLite.
// We can read back the resolved data (author profile, content, reactions)
// from the materialized tables.
// ───────────────────────────────────────────────────────────────────────

interface AuthorProfile {
  name: string;
  avatar: string | null;
}

const UNKNOWN_PROFILE: AuthorProfile = { name: "", avatar: null };

function resolveProfile(did: UserDid): AuthorProfile {
  try {
    const row = openDb()
      .query<
        { name: string | null; avatar: string | null },
        [string]
      >("SELECT name, avatar FROM comp_info WHERE entity = ?")
      .get(did);
    if (!row) return UNKNOWN_PROFILE;
    return { name: row.name ?? "", avatar: row.avatar ?? null };
  } catch {
    return UNKNOWN_PROFILE;
  }
}

function resolveContent(messageId: Ulid): string {
  try {
    const row = openDb()
      .query<
        { mime_type: string | null; data: Buffer | null },
        [string]
      >("SELECT mime_type, data FROM comp_content WHERE entity = ?")
      .get(messageId);
    if (!row || !row.data) return "";
    const buf = row.data instanceof Buffer ? row.data : Buffer.from(row.data);
    if (!row.mime_type || row.mime_type.startsWith("text/") || row.mime_type === "application/json") {
      return buf.toString("utf8");
    }
    return buf.toString("base64");
  } catch {
    return "";
  }
}

function resolveReplyTo(messageId: Ulid): Ulid | null {
  try {
    const row = openDb()
      .query<{ tail: string }, [string]>(
        "SELECT tail FROM edges WHERE head = ? AND label = 'reply'",
      )
      .get(messageId);
    return (row?.tail as Ulid | null) ?? null;
  } catch {
    return null;
  }
}

function resolveReactions(
  messageId: Ulid,
  viewerDid?: UserDid,
): Array<{ emoji: string; dids: UserDid[]; myReactionId: string | null }> {
  try {
    const rows = openDb()
      .query<{ reaction: string; user: string; reaction_id: string }, [string]>(
        "SELECT reaction, user, reaction_id FROM comp_reaction WHERE entity = ?",
      )
      .all(messageId);
    if (rows.length === 0) return [];
    const map = new Map<string, { dids: UserDid[]; viewerReactionId: string | null }>();
    for (const r of rows) {
      let entry = map.get(r.reaction);
      if (!entry) {
        entry = { dids: [], viewerReactionId: null };
        map.set(r.reaction, entry);
      }
      entry.dids.push(r.user as UserDid);
      if (viewerDid && r.user === viewerDid) {
        entry.viewerReactionId = r.reaction_id;
      }
    }
    return [...map.entries()].map(([emoji, { dids, viewerReactionId }]) => ({
      emoji,
      dids,
      myReactionId: viewerReactionId,
    }));
  } catch {
    return [];
  }
}

// ─── Dispatch table ─────────────────────────────────────────────────────

const HANDLERS: Record<string, (event: AppliedEvent) => InvalidationEvent[]> = {
  // Messages
  "space.roomy.message.createMessage.v0": handleCreateMessage,
  "space.roomy.message.editMessage.v0": handleEditMessage,
  "space.roomy.message.deleteMessage.v0": handleDeleteMessage,
  "space.roomy.message.moveMessages.v0": () => [],
  "space.roomy.message.reorderMessage.v0": () => [],
  "space.roomy.message.forwardMessages.v0": handleCreateMessage,

  // Reactions
  "space.roomy.reaction.addReaction.v0": handleReactionChange,
  "space.roomy.reaction.removeReaction.v0": handleReactionChange,
  "space.roomy.reaction.addBridgedReaction.v0": handleReactionChange,
  "space.roomy.reaction.removeBridgedReaction.v0": handleReactionChange,

  // Rooms
  "space.roomy.room.createRoom.v0": handleCreateRoom,
  "space.roomy.room.updateRoom.v0": handleUpdateRoom,
  "space.roomy.room.deleteRoom.v0": handleDeleteRoom,
  "space.roomy.room.restoreRoom.v0": handleRestoreRoom,

  // Space
  "space.roomy.space.joinSpace.v0": handleJoinSpace,
  "space.roomy.space.leaveSpace.v0": handleLeaveSpace,
  "space.roomy.space.updateSpaceInfo.v0": handleUpdateSpaceInfo,
  "space.roomy.space.updateSidebar.v0": handleUpdateSidebar,
  "space.roomy.space.updateSidebar.v1": handleUpdateSidebar,
  "space.roomy.space.addAdmin.v0": handleAddAdmin,
  "space.roomy.space.removeAdmin.v0": handleRemoveAdmin,
  "space.roomy.space.banAccount.v0": handleBanAccount,
  "space.roomy.space.unbanAccount.v0": handleUnbanAccount,
  "space.roomy.space.setHandleProvider.v0": handleUpdateSpaceInfo,

  // Personal stream
  "space.roomy.space.personal.joinSpace.v0": handlePersonalJoinSpace,
  "space.roomy.space.personal.leaveSpace.v0": handlePersonalLeaveSpace,

  // Links
  "space.roomy.link.createRoomLink.v0": handleCreateRoomLink,
  "space.roomy.link.removeRoomLink.v0": handleRemoveRoomLink,

  // Roles
  "space.roomy.role.createRole.v0": handleCreateRole,
  "space.roomy.role.deleteRole.v0": handleDeleteRole,
  "space.roomy.role.updateRole.v0": handleUpdateRole,
  "space.roomy.role.addMemberRole.v0": handleAddMemberRole,
  "space.roomy.role.removeMemberRole.v0": handleRemoveMemberRole,
  "space.roomy.role.setRoleRoomPermission.v0": handleSetRoleRoomPermission,

  // Invites
  "space.roomy.space.createInvite.v0": handleCreateInvite,
  "space.roomy.space.revokeInvite.v0": handleRevokeInvite,

  // User profile
  "space.roomy.user.updateProfile.v0": handleUpdateProfile,

  // State
  "space.roomy.state.markRead.v0": handleMarkRead,

  // Calendar — no XRPC endpoints yet
  "space.roomy.openmeet.configure.v0": () => [],

  // Pages — out of scope
  "space.roomy.page.editPage.v0": () => [],
};
