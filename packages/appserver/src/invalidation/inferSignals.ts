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
import type { DbLike } from "../db/types.ts";
import { openDb } from "../db/db.ts";
import { selectMessages, type MessageDto } from "../queries/selectMessages.ts";
import { getRoomReadPositionUsers } from "../queries/readPositions.ts";

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Infer invalidation signals for a single applied event.
 * Returns an array (can be empty for events that don't affect query results,
 * e.g. synthetic backfill events).
 *
 * @param event - The applied event to infer signals for.
 * @param db - Optional database instance. Defaults to `openDb()`.
 * @param messageSnapshots - Optional pre-fetched message rows keyed by
 *   message id. When the caller has already batch-fetched the messages a
 *   batch of events will reference (e.g. `Router.onEventsApplied`), passing
 *   the map here lets `handleCreateMessage` / `handleEditMessage` skip the
 *   per-event `selectMessages` re-read — turning 5N queries into 5 per
 *   batch. Handlers fall back to their own read when the map is absent or
 *   does not contain the relevant id (direct callers like tests).
 */
export async function inferSignals(
  event: AppliedEvent,
  db?: DbLike,
  messageSnapshots?: ReadonlyMap<Ulid, MessageDto>,
): Promise<InvalidationEvent[]> {
  // Suppress signals for synthetic query events — they're bulk hydration,
  // not incremental changes.
  if (event.type.startsWith("space.roomy.query.")) return [];

  const handler = HANDLERS[event.type as keyof typeof HANDLERS];
  if (!handler) return [];
  return await handler(event, db, messageSnapshots);
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

async function handleCreateMessage(
  event: AppliedEvent,
  db?: DbLike,
  messageSnapshots?: ReadonlyMap<Ulid, MessageDto>,
): Promise<InvalidationEvent[]> {
  const roomId = event.roomId;
  if (!roomId) return [];

  const spaceId = event.streamDid;
  const details = event.details ?? {};

  // Resolve the full message row to carry in the #messageDiff. The client
  // validates the diff against the `room.getMessages` response schema and
  // silently drops it if any field is missing, so the payload must match
  // the exact shape `selectMessages` returns.
  //
  // Prefer a pre-fetched snapshot from the batch (Router.onEventsApplied
  // collects all message ids in a batch and reads them with a single
  // `selectMessages` call — 5 queries per batch instead of 5N). Fall back
  // to a per-event read for direct callers (tests, standalone use).
  const message = messageSnapshots?.get(event.id) ?? (
    await selectMessages(db ?? openDb(), { kind: "ids", ids: [event.id] })
  ).messages[0];

  const signals: InvalidationEvent[] = [];
  if (message) {
    // Message diff — applied directly to WS client cache, no HTTP re-fetch.
    signals.push({
      kind: "messageDiff",
      signal: {
        roomId,
        seq: (details.seq as number) ?? 0,
        ops: [{ op: "add", key: event.id, message }],
      },
    });
  }

  // Per-user unread-count diff. The materializer already bumped
  // `unread_count + 1` for every user with a `read_positions` row for
  // this room; one read here yields the affected user set. The
  // SyncManager sends a dedicated `#roomMetadataDiff` frame to each
  // user's connection, which patches `room.getMetadata.unreadCount`,
  // the matching `SpaceRow.unreadCount` in `getSpaces`, and the channel
  // entry in the `space.getMetadata` sidebar tree — all with `delta +1`,
  // no refetch.
  const users = await getRoomReadPositionUsers(db ?? openDb(), roomId);
  if (users.length > 0) {
    signals.push({
      kind: "roomMetadataDiff",
      signal: {
        spaceId,
        roomId,
        seq: 0,
        delta: 1,
        users,
      },
    });
  }

  // recentThreads / room.getThreads may have changed (the new message is
  // the latest activity in the room). Unread count is handled by the diff
  // above, so this invalidation is only for the thread-activity fields.
  signals.push(invalidate("space.roomy.room.getMetadata", { roomId }));
  signals.push(invalidate("space.roomy.room.getThreads", { roomId }));

  // A message in a thread may update the author's `activeThreads` in the
  // space sidebar. The `roomMetadataDiff` only patches `unreadCount`, not
  // `activeThreads`, so invalidate `space.getMetadata` for the author only.
  signals.push(
    invalidate("space.roomy.space.getMetadata", { spaceId }, event.user),
  );

  return signals;
}

async function handleEditMessage(
  event: AppliedEvent,
  db?: DbLike,
  messageSnapshots?: ReadonlyMap<Ulid, MessageDto>,
): Promise<InvalidationEvent[]> {
  const roomId = event.roomId;
  if (!roomId) return [];

  const details = event.details ?? {};
  // editMessage's `event.id` is the edit event's own ULID, NOT the message
  // id. The message being edited is `details.messageId` (surfaced by
  // `toAppliedEvent`). Key the diff by the message id so the client can
  // match it to the existing cache entry; fall back to `event.id` only for
  // events that pre-date this field.
  const messageId = (details.messageId as Ulid | undefined) ?? event.id;

  // Re-read the full message row post-materialization so the diff carries
  // the complete, schema-valid shape (see `handleCreateMessage`). Prefer a
  // pre-fetched batch snapshot when available (see `handleCreateMessage`
  // for the rationale).
  const message = messageSnapshots?.get(messageId) ?? (
    await selectMessages(db ?? openDb(), { kind: "ids", ids: [messageId] })
  ).messages[0];

  const signals: InvalidationEvent[] = [];
  if (message) {
    signals.push({
      kind: "messageDiff",
      signal: {
        roomId,
        seq: (details.seq as number) ?? 0,
        ops: [{ op: "update", key: messageId, message }],
      },
    });
  }
  // Edit doesn't change unread count, but room metadata's recentThreads
  // might reference this message's activity.
  signals.push(invalidate("space.roomy.room.getMetadata", { roomId }));

  return signals;
}

function handleDeleteMessage(event: AppliedEvent): InvalidationEvent[] {
  const roomId = event.roomId;
  if (!roomId) return [];

  const details = event.details ?? {};
  // deleteMessage's `event.id` is the delete event's own ULID; the message
  // being removed is `details.messageId`. Key the `remove` op by the
  // message id so the client can match and drop the right cache entry.
  const messageId = (details.messageId as Ulid | undefined) ?? event.id;

  return [
    {
      kind: "messageDiff",
      signal: {
        roomId,
        seq: (details.seq as number) ?? 0,
        ops: [{ op: "remove", key: messageId }],
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
  const spaceId = event.streamDid;

  const signals: InvalidationEvent[] = [
    invalidate("space.roomy.room.getMessages", { roomId }),
    // A reaction on (or removing one from) a room's latest message changes
    // that feed item's rendered reactions. The activity feed is a global
    // per-user query (like getSpaces), so invalidate with no params — the
    // client prefix-matches every activity-feed query key (any space/limit).
    // Per the "over-invalidate" principle this broadcasts to all users;
    // a reaction on a non-latest message triggers a harmless no-op refetch.
    invalidate("space.roomy.space.getActivityFeed", {}),
    ...(details.messageId
      ? [
          invalidate("space.roomy.message.getMessage", {
            messageId: details.messageId as string,
          }),
        ]
      : []),
  ];

  // Reaction in a thread may update the user's activeThreads sidebar.
  // Scope invalidation to the reacting user only.
  if (roomId) {
    signals.push(
      invalidate("space.roomy.space.getMetadata", { spaceId }, event.user),
    );
  }

  return signals;
}

// ─── Room events ────────────────────────────────────────────────────────

function handleCreateRoom(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const roomId = event.id; // For createRoom events, the event's id IS the room ID

  const signals: InvalidationEvent[] = [
    ...invalidateSpace(spaceId),
    // New room means sidebar changed.
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    // Room-scoped queries need invalidation so the client can fetch
    // metadata and messages for the newly created room. Without these,
    // a client that navigated to the room before the materializer
    // processed the event (or that re-subscribes to a room while the
    // materializer is still catching up) gets stuck with stale/empty data.
    invalidate("space.roomy.room.getMessages", { roomId }),
    invalidate("space.roomy.room.getMetadata", { roomId }),
    invalidate("space.roomy.room.getThreads", { roomId }),
  ];

  return signals;
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
    signals.push(
      invalidate("space.roomy.space.getMembers", { spaceId }),
      // getMetadata returns isMember, which flips to false on leave.
      // Mirror handlePersonalJoinSpace (which emits getMetadata) so the
      // leaver's cached space metadata is invalidated, not just getSpaces.
      invalidate("space.roomy.space.getMetadata", { spaceId }, event.user),
    );
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

// ─── Dispatch table ─────────────────────────────────────────────────────

const HANDLERS: Record<string, (event: AppliedEvent, db?: DbLike, messageSnapshots?: ReadonlyMap<Ulid, MessageDto>) => InvalidationEvent[] | Promise<InvalidationEvent[]>> = {
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
