/**
 * Per-event write authorization for the `sendEvents` procedure.
 *
 * Self-contained, decision-only module — same coupling rules as `access.ts`:
 *   - No imports from `src/xrpc/`, `src/handlers/`, `src/hydration/`.
 *   - No `XrpcError`, no HTTP status codes, no logging.
 *
 * Returns `undefined` for "allowed" or a `{ status, error, message }` denial.
 * The handler layer translates denials into XrpcErrors.
 */

import type { DbLike } from "../db/types.ts";
import {
  spaceAccess,
  roomAccess,
  isAdmin,
  isMember,
  isBanned,
} from "./access.ts";

// ── Result type ──────────────────────────────────────────────────────────

export interface WriteAuthDenial {
  status: 400 | 403 | 404;
  error: string;
  message: string;
}

export type WriteAuthResult = undefined | WriteAuthDenial;

// ── Allow list / reject set ──────────────────────────────────────────────

/**
 * Event types that must NOT be sent through this endpoint.
 * They target the personal stream or have been replaced by dedicated XRPCs.
 */
const REJECTED_TYPES = new Set([
  "space.roomy.space.personal.joinSpace.v0",
  "space.roomy.space.personal.leaveSpace.v0",
  "space.roomy.state.markRead.v0",
]);

/**
 * All known event types that are allowed through this endpoint.
 * Built from the SDK's event registry keys minus rejected types.
 */
const ALLOWED_TYPES: Set<string> = new Set([
  // Room write
  "space.roomy.message.createMessage.v0",
  "space.roomy.message.editMessage.v0",
  "space.roomy.message.deleteMessage.v0",
  "space.roomy.message.moveMessages.v0",
  "space.roomy.message.reorderMessage.v0",
  "space.roomy.message.forwardMessages.v0",
  "space.roomy.reaction.addReaction.v0",
  "space.roomy.reaction.removeReaction.v0",
  "space.roomy.link.createRoomLink.v0",
  "space.roomy.link.removeRoomLink.v0",
  // Room manage
  "space.roomy.room.createRoom.v0",
  "space.roomy.room.updateRoom.v0",
  "space.roomy.room.deleteRoom.v0",
  "space.roomy.room.restoreRoom.v0",
  // Space manage
  "space.roomy.space.updateSpaceInfo.v0",
  "space.roomy.space.updateSidebar.v0",
  "space.roomy.space.updateSidebar.v1",
  "space.roomy.space.setHandleProvider.v0",
  "space.roomy.space.addAdmin.v0",
  "space.roomy.space.removeAdmin.v0",
  "space.roomy.space.banAccount.v0",
  "space.roomy.space.unbanAccount.v0",
  "space.roomy.role.createRole.v0",
  "space.roomy.role.deleteRole.v0",
  "space.roomy.role.updateRole.v0",
  "space.roomy.role.addMemberRole.v0",
  "space.roomy.role.removeMemberRole.v0",
  "space.roomy.role.setRoleRoomPermission.v0",
  "space.roomy.space.revokeInvite.v0",
  "space.roomy.page.editPage.v0",
  "space.roomy.openmeet.configure.v0",
  // Space member
  "space.roomy.space.joinSpace.v0",
  "space.roomy.space.leaveSpace.v0",
  "space.roomy.user.updateProfile.v0",
  "space.roomy.space.createInvite.v0",
  // Bridged
  "space.roomy.reaction.addBridgedReaction.v0",
  "space.roomy.reaction.removeBridgedReaction.v0",
]);

// ── Auth category dispatch ───────────────────────────────────────────────

/**
 * Room-write events — require `roomAccess(db, event.room, did).canWrite`
 * AND space membership (already encoded in `canWrite`).
 */
const ROOM_WRITE_TYPES = new Set([
  "space.roomy.message.createMessage.v0",
  "space.roomy.message.moveMessages.v0",
  "space.roomy.message.reorderMessage.v0",
  "space.roomy.message.forwardMessages.v0",
  "space.roomy.reaction.addReaction.v0",
  "space.roomy.reaction.removeReaction.v0",
  "space.roomy.link.createRoomLink.v0",
  "space.roomy.link.removeRoomLink.v0",
]);

/**
 * Room-write events that additionally require author-or-admin check.
 */
const MESSAGE_AUTHOR_TYPES = new Set([
  "space.roomy.message.editMessage.v0",
  "space.roomy.message.deleteMessage.v0",
]);

/**
 * Room management events — require space admin.
 */
const ROOM_MANAGE_TYPES = new Set([
  "space.roomy.room.createRoom.v0",
  "space.roomy.room.updateRoom.v0",
  "space.roomy.room.deleteRoom.v0",
  "space.roomy.room.restoreRoom.v0",
]);

/**
 * Space management events — require space admin.
 */
const SPACE_MANAGE_TYPES = new Set([
  "space.roomy.space.updateSpaceInfo.v0",
  "space.roomy.space.updateSidebar.v0",
  "space.roomy.space.updateSidebar.v1",
  "space.roomy.space.setHandleProvider.v0",
  "space.roomy.space.addAdmin.v0",
  "space.roomy.space.removeAdmin.v0",
  "space.roomy.space.banAccount.v0",
  "space.roomy.space.unbanAccount.v0",
  "space.roomy.role.createRole.v0",
  "space.roomy.role.deleteRole.v0",
  "space.roomy.role.updateRole.v0",
  "space.roomy.role.addMemberRole.v0",
  "space.roomy.role.removeMemberRole.v0",
  "space.roomy.role.setRoleRoomPermission.v0",
  "space.roomy.space.revokeInvite.v0",
  "space.roomy.page.editPage.v0",
  "space.roomy.openmeet.configure.v0",
]);

/**
 * Space member events — require membership (not banned).
 */
const SPACE_MEMBER_TYPES = new Set([
  "space.roomy.space.joinSpace.v0",
  "space.roomy.space.leaveSpace.v0",
  "space.roomy.user.updateProfile.v0",
  "space.roomy.space.createInvite.v0",
]);

/**
 * Bridged events — require space admin.
 */
const BRIDGED_TYPES = new Set([
  "space.roomy.reaction.addBridgedReaction.v0",
  "space.roomy.reaction.removeBridgedReaction.v0",
]);

// ── Helper: denial constructors ──────────────────────────────────────────

function denied(
  status: 400 | 403 | 404,
  error: string,
  message: string,
): WriteAuthDenial {
  return { status, error, message };
}

// ── Auth check helpers ───────────────────────────────────────────────────

async function requireSpaceAdminCheck(
  db: DbLike,
  spaceId: string,
  did: string,
): Promise<WriteAuthResult> {
  const admin = await isAdmin(db, spaceId, did);
  if (!admin) {
    return denied(403, "Forbidden", "Caller is not a space admin");
  }
  return undefined;
}

async function requireMembershipCheck(
  db: DbLike,
  spaceId: string,
  did: string,
): Promise<WriteAuthResult> {
  const access = await spaceAccess(db, spaceId, did);
  if (access.isBanned) {
    return denied(403, "Forbidden", "Caller is banned from this space");
  }
  if (!access.isMember && !access.isAdmin) {
    return denied(
      403,
      "Forbidden",
      "Caller is not a member of this space",
    );
  }
  return undefined;
}

async function requireNotBannedCheck(
  db: DbLike,
  spaceId: string,
  did: string,
): Promise<WriteAuthResult> {
  const banned = await isBanned(db, spaceId, did);
  if (banned) {
    return denied(403, "Forbidden", "Caller is banned from this space");
  }
  return undefined;
}

async function requireRoomWriteCheck(
  db: DbLike,
  roomId: string,
  did: string,
): Promise<WriteAuthResult> {
  const access = await roomAccess(db, roomId, did);
  if (!access.exists) {
    return denied(404, "NotFound", `Room not found: ${roomId}`);
  }
  if (access.isBanned) {
    return denied(403, "Forbidden", "Caller is banned from this space");
  }
  if (!access.canWrite) {
    return denied(
      403,
      "Forbidden",
      "Caller does not have write access to this room",
    );
  }
  return undefined;
}

/**
 * For editMessage/deleteMessage: the caller must be the original author
 * OR a space admin.
 */

async function checkMessageAuthorOrAdmin(
  db: DbLike,
  messageId: string,
  callerDid: string,
  spaceId: string,
): Promise<WriteAuthResult> {
  const admin = await isAdmin(db, spaceId, callerDid);
  if (admin) return undefined;

  const row = await db.query("SELECT tail FROM edges WHERE head = ? AND label = 'author' LIMIT 1").get<{ tail: string }>([messageId]);
  if (!row || row.tail !== callerDid) {
    return denied(
      403,
      "Forbidden",
      "Only the message author or a space admin can edit/delete this message",
    );
  }
  return undefined;
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Check whether the caller is authorized to send a single event.
 *
 * @returns `undefined` if allowed, or a denial object.
 */
export async function checkWriteAuth(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
): Promise<WriteAuthResult> {
  const { $type } = event;

  // Reject banned types
  if (REJECTED_TYPES.has($type)) {
    return denied(
      400,
      "InvalidRequest",
      `Event type ${$type} is not accepted by this endpoint`,
    );
  }

  // Unknown types
  if (!ALLOWED_TYPES.has($type)) {
    return denied(
      400,
      "InvalidRequest",
      `Unknown event type: ${$type}`,
    );
  }

  // ── Room write ──
  if (ROOM_WRITE_TYPES.has($type)) {
    const roomId = event.room;
    if (typeof roomId !== "string") {
      return denied(400, "InvalidRequest", `Event is missing required 'room' field`);
    }
    return await requireRoomWriteCheck(db, roomId, callerDid);
  }

  // ── Room write + author check (edit/delete) ──
  if (MESSAGE_AUTHOR_TYPES.has($type)) {
    const roomId = event.room;
    if (typeof roomId !== "string") {
      return denied(400, "InvalidRequest", `Event is missing required 'room' field`);
    }
    const roomResult = await requireRoomWriteCheck(db, roomId, callerDid);
    if (roomResult) return roomResult;

    // Additional author-or-admin check
    const messageId = event.messageId;
    if (typeof messageId !== "string") {
      return denied(400, "InvalidRequest", `Event is missing required 'messageId' field`);
    }
    return await checkMessageAuthorOrAdmin(db, messageId, callerDid, spaceId);
  }

  // ── Room manage ──
  if (ROOM_MANAGE_TYPES.has($type)) {
    return await requireSpaceAdminCheck(db, spaceId, callerDid);
  }

  // ── Space manage ──
  if (SPACE_MANAGE_TYPES.has($type)) {
    return await requireSpaceAdminCheck(db, spaceId, callerDid);
  }

  // ── Space member ──
  if (SPACE_MEMBER_TYPES.has($type)) {
    // joinSpace only requires "not banned"
    if ($type === "space.roomy.space.joinSpace.v0") {
      return await requireNotBannedCheck(db, spaceId, callerDid);
    }
    return await requireMembershipCheck(db, spaceId, callerDid);
  }

  // ── Bridged ──
  if (BRIDGED_TYPES.has($type)) {
    return await requireSpaceAdminCheck(db, spaceId, callerDid);
  }

  // Should be unreachable if ALLOWED_TYPES and the dispatch tables agree
  return denied(400, "InvalidRequest", `Unhandled event type: ${$type}`);
}

/**
 * The full set of allowed `$type` values. Exported for testing/validation.
 */
export { ALLOWED_TYPES, REJECTED_TYPES };
