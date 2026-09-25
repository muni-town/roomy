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
  roomAccessMany,
  isAdmin,
  isMember,
  isBanned,
  type AccessMemo,
  type SpaceAccess,
} from "./access.ts";
import {
  type FederationMemo,
  federatedRoomAccess,
} from "./federation.ts";

// ── Result type ──────────────────────────────────────────────────────────

export interface WriteAuthDenial {
  status: 400 | 403 | 404 | 409;
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
  // Channel federation (relationship lifecycle)
  "space.roomy.federation.request.v0",
  "space.roomy.federation.respond.v0",
  "space.roomy.federation.remove.v0",
  "space.roomy.federation.setRoomPermission.v0",
  "space.roomy.federation.setReceiverPermission.v0",
]);

// ── Auth category dispatch ───────────────────────────────────────────────

/**
 * Room-write events — require `roomAccess(db, event.room, did).canWrite`
 * AND space membership (already encoded in `canWrite`).
 */
const ROOM_WRITE_TYPES = new Set([
  "space.roomy.message.createMessage.v0",
  "space.roomy.message.reorderMessage.v0",
  "space.roomy.message.forwardMessages.v0",
  "space.roomy.reaction.addReaction.v0",
  "space.roomy.reaction.removeReaction.v0",
  "space.roomy.link.createRoomLink.v0",
  "space.roomy.link.removeRoomLink.v0",
]);

// NB: `space.roomy.message.moveMessages.v0` is deliberately NOT in
// ROOM_WRITE_TYPES. It is a curator action (it rewrites another room's
// timeline and both rooms' unread/activity state), so it is dispatched to
// `checkMoveMessages` below — space admin, plus a destination-room guard.

/**
 * Message events that may carry a `space.roomy.attachment.reply.v0`.
 *
 * The reply's `target` is a bare ULID with no type attached, and nothing in
 * the write path checked it: the materialiser inserts the `reply` edge
 * unconditionally (`insert or ignore`, so even a non-existent target is
 * silently dropped), and `message.getMessage` REJECTS a non-message target
 * with a 400. A reply aimed at, say, the room it lives in therefore
 * materialises fine and then renders as a permanently failing reply preview
 * — the client asks `getMessage` for a room id four times and gets 400 four
 * times. See {@link checkReplyTargets}.
 */
const REPLY_TARGET_TYPES = new Set([
  "space.roomy.message.createMessage.v0",
  "space.roomy.message.editMessage.v0",
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
 *
 * `createRoom.v0` is handled specially below (split by `kind`): creating a
 * thread room is allowed for any space member, with the actual
 * "write access to the parent channel" enforced by the paired
 * `space.roomy.link.createRoomLink.v0` event (in ROOM_WRITE_TYPES, gated on
 * `canWrite` of the target channel). Creating channels/pages, and
 * updating/deleting/restoring any room, still require space admin.
 */
const ROOM_MANAGE_TYPES = new Set([
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

/**
 * Channel-federation relationship events.
 *
 * `respond`/`remove` target the origin space (A) and require an A admin.
 * `request` is sent on A's stream but originates from space B: the caller
 * must be an admin of B AND a member of A (the federation precondition).
 * Resolving admin-of-B requires the *other* space's DB handle, supplied via
 * the optional `dbResolver` so this module stays pure and testable.
 */
const FEDERATION_TYPES = new Set([
  "space.roomy.federation.request.v0",
  "space.roomy.federation.respond.v0",
  "space.roomy.federation.remove.v0",
  "space.roomy.federation.setRoomPermission.v0",
  "space.roomy.federation.setReceiverPermission.v0",
]);

// ── Service self-write (root of trust) ───────────────────────────────────

/**
 * Event types the appserver's own DID may write to ANY space without
 * holding membership or admin there.
 *
 * The appserver is the root of trust for Roomy spaces: it owns the space
 * stream's event log and it is what evaluates every other caller's write
 * against `writeAuth`. It nonetheless authors some events itself — the
 * Roomy Pro members-role reconciliation sweep is the first — and requiring
 * the service to be a *space admin* to do so would mean granting a host
 * process membership it does not need and cannot meaningfully hold (it is
 * `did:web`, not a space participant).
 *
 * The relaxation is deliberately narrow:
 *   - only the exact event types listed here,
 *   - only when the caller IS the configured service DID (the same DID the
 *     auth verifier enforces as its JWT audience, so it cannot be forged
 *     without the appserver's signing key),
 *   - additive: every other rule still applies to the service DID, so a
 *     deployment that has made it a space admin keeps working.
 *
 * `addAdmin`, `removeAdmin`, `banAccount` and `updateSpaceInfo` are
 * deliberately ABSENT: a compromised or repurposed reconciliation path must
 * not be able to escalate anyone's authority through this endpoint.
 */
const SERVICE_SELF_WRITE_TYPES = {
  "space.roomy.role.addMemberRole.v0": true,
  "space.roomy.role.removeMemberRole.v0": true,
} as const satisfies Record<string, true>;

/**
 * The exact `$type` values the service DID may self-write. Internal writers
 * (the Pro members-role sweep) type their event constructors as this union,
 * so widening what the service writes past what this endpoint authorizes is
 * a compile error rather than a silent authorization gap.
 */
export type ServiceSelfWriteType = keyof typeof SERVICE_SELF_WRITE_TYPES;

// ── Helper: denial constructors ──────────────────────────────────────────

function denied(
  status: 400 | 403 | 404 | 409,
  error: string,
  message: string,
): WriteAuthDenial {
  return { status, error, message };
}

// ── Per-request authorization context ────────────────────────────────────

/**
 * Shared state for authorizing a *batch* of events in one request.
 *
 * `sendEvents` authorizes up to `MAX_BATCH_SIZE` (50) events in a loop, and
 * every check re-derives the same facts: the caller's membership/admin/ban
 * flags in the target space, the target room's `default_access` + parent
 * channel, and every room's role grants. Resolved per event, a 50-message
 * batch to one room issues ~15 SQL round-trips per event for facts that
 * cannot differ between them, so authorization must cost a constant per
 * request — one access decision for the page, not N × constant.
 *
 * The memos are per-request by construction (created in the handler, never
 * shared across requests) — access state changes through events, so a
 * longer-lived cache would be a security bug, exactly as documented on
 * `AccessMemo`.
 *
 * `dbResolver` / `globalDb` are only consulted by the federation checks, and
 * `serviceDid` by the service self-write rule.
 */
export interface WriteAuthContext {
  /**
   * The caller's pre-resolved `SpaceAccess` for the target space. The handler
   * resolves it once (it needs it for the ban gate anyway); passing it here
   * keeps the space-level checks off the DB entirely.
   */
  access?: SpaceAccess;
  /** Per-request access memo — share room/space decisions across the batch. */
  accessMemo?: AccessMemo;
  /** Per-request federation memo — shares the global-DB federation lookups. */
  federationMemo?: FederationMemo;
  dbResolver?: (spaceDid: string) => DbLike;
  globalDb?: DbLike;
  serviceDid?: string;
}

/**
 * Resolve every room a batch's events will check, in one batched pass, into
 * `memo` — so the per-event `roomAccess` calls in the authorize loop are memo
 * hits instead of ~7 SQL round-trips each.
 *
 * Called before the authorize loop, deliberately: the loop's ordering (and
 * therefore which denial a mixed batch reports) is unchanged, and this only
 * reads. Results land in the same memo the loop reads from, so a prewarmed
 * room and an on-demand one are indistinguishable to callers.
 *
 * The ids are taken from the *raw* (unparsed) events so this can run before
 * validation without changing which error a malformed batch produces:
 *   - `room` is the write target for every room-write type, and for
 *     edit/delete;
 *   - `toRoomId` is `moveMessages`' destination guard.
 * An id that turns out not to be a room resolves to `exists: false`, which
 * is what the unbatched path would have computed for it anyway.
 *
 * Must stay in parity with `checkWriteAuth`'s dispatch: if a type's auth
 * reads a room id this does not collect, that room is simply resolved on
 * demand as before (correct, just not batched).
 */
export async function prewarmWriteAuthAccess(
  db: DbLike,
  events: Array<Record<string, unknown>>,
  did: string,
  memo: AccessMemo,
): Promise<void> {
  const roomIds: string[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    if (typeof event.room === "string") roomIds.push(event.room);
    if (typeof event.toRoomId === "string") roomIds.push(event.toRoomId);
  }
  if (roomIds.length === 0) return;
  await roomAccessMany(db, roomIds, did, memo);
}

// ── Auth check helpers ───────────────────────────────────────────────────
async function requireSpaceAdminCheck(
  db: DbLike,
  spaceId: string,
  did: string,
  ctx: WriteAuthContext,
): Promise<WriteAuthResult> {
  const admin = ctx.access
    ? ctx.access.isAdmin
    : await isAdmin(db, spaceId, did, ctx.accessMemo);
  if (!admin) {
    return denied(403, "Forbidden", "Caller is not a space admin");
  }
  return undefined;
}

async function requireMembershipCheck(
  db: DbLike,
  spaceId: string,
  did: string,
  ctx: WriteAuthContext,
): Promise<WriteAuthResult> {
  const a = ctx.access ?? await spaceAccess(db, spaceId, did, ctx.accessMemo);
  if (a.isBanned) {
    return denied(403, "Forbidden", "Caller is banned from this space");
  }
  if (!a.isMember && !a.isAdmin) {
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
  ctx: WriteAuthContext,
): Promise<WriteAuthResult> {
  const banned = ctx.access
    ? ctx.access.isBanned
    : await isBanned(db, spaceId, did, ctx.accessMemo);
  if (banned) {
    return denied(403, "Forbidden", "Caller is banned from this space");
  }
  return undefined;
}


async function requireRoomWriteCheck(
  db: DbLike,
  roomId: string,
  did: string,
  ctx: WriteAuthContext,
): Promise<WriteAuthResult> {
  const { accessMemo, globalDb, dbResolver } = ctx;
  const access = await roomAccess(db, roomId, did, accessMemo);
  if (!access.exists) {
    return denied(404, "NotFound", `Room not found: ${roomId}`);
  }
  if (access.isBanned) {
    return denied(403, "Forbidden", "Caller is banned from this space");
  }
  if (access.canWrite) return undefined;

  // Federation fallback: a member of a federated receiving space
  // may write when both the origin and receiver grants allow it.
  if (globalDb && dbResolver) {
    const fed = await federatedRoomAccess(db, globalDb, roomId, did, {
      spaceDbResolver: dbResolver,
      memo: ctx.federationMemo,
      accessMemo,
    });
    if (fed && fed.canWrite) return undefined;
  }
  return denied(
    403,
    "Forbidden",
    "Caller does not have write access to this room",
  );
}

/**
 * Authorize a `moveMessages` event. Requires a space admin, plus two guards
 * that the materializer cannot enforce on its own:
 *
 *   - the destination room must exist (otherwise the message would be
 *     materialised into a room that isn't there, invisible to every read),
 *   - the destination must be in the SAME space. The event is written to one
 *     space's stream and the materializer blindly rewrites the per-space
 *     `entities.room`, so a cross-space id would point a message at a room
 *     that lives in a different DB.
 *
 * Like every other room-write event, this requires the referenced room to be
 * materialized already — a room created in the same batch is not (see
 * `sendEvents`; `createRoom` + `createMessage` in one batch is likewise
 * rejected). Callers create the destination first, then move into it.
 */
async function checkMoveMessages(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
  ctx: WriteAuthContext,
): Promise<WriteAuthResult> {
  const adminResult = await requireSpaceAdminCheck(db, spaceId, callerDid, ctx);
  if (adminResult) return adminResult;

  const toRoomId = event.toRoomId;
  if (typeof toRoomId !== "string") {
    return denied(400, "InvalidRequest", "Event is missing required 'toRoomId' field");
  }
  const destination = await roomAccess(db, toRoomId, callerDid, ctx.accessMemo);
  if (!destination.exists) {
    return denied(404, "NotFound", `Destination room not found: ${toRoomId}`);
  }
  if (destination.spaceId !== spaceId) {
    return denied(
      400,
      "InvalidRequest",
      `Destination room ${toRoomId} is not in this space`,
    );
  }
  return undefined;
}

/**
 * Authorize the reply targets attached to a message event.
 *
 * A `space.roomy.attachment.reply.v0` carries a bare `target` ULID. The
 * materialiser writes the `reply` edge for it unconditionally, but
 * `message.getMessage` resolves the target as a *message* and returns
 * `400 InvalidRequest "Entity <id> is not a message (no room)"` for anything
 * else — a room, a user, an embed entity. The result is a message whose reply
 * preview can never resolve, refetched on every render.
 *
 * Two distinct cases, both rejected here so the bad edge is never written:
 *
 *   - the target does not exist at all. The materialiser's `insert or ignore`
 *     silently drops the edge, so the reply renders as "Reply unavailable"
 *     with no clue why.
 *   - the target exists but is not a message. A message is the only entity
 *     type that carries a `room` (every other entity — room, user, space,
 *     attachment — has `room` null), which is exactly the predicate
 *     `getMessage` uses to make the same call. Keeping the two in step is
 *     what makes this an admission-time check rather than a heuristic.
 *
 * A target in a *different* room is allowed: cross-room replies are
 * legitimate (the search handler denormalises them, and the client resolves
 * them by id). Only the not-a-message case is refused.
 */
async function checkReplyTargets(
  db: DbLike,
  event: { $type: string; [k: string]: unknown },
): Promise<WriteAuthResult> {
  if (!REPLY_TARGET_TYPES.has(event.$type)) return undefined;

  const extensions = event.extensions;
  if (typeof extensions !== "object" || extensions === null) return undefined;
  const attachmentsExt = (
    extensions as Record<string, unknown>
  )["space.roomy.extension.attachments.v0"];
  if (typeof attachmentsExt !== "object" || attachmentsExt === null) {
    return undefined;
  }
  const attachments = (attachmentsExt as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) return undefined;

  for (const att of attachments) {
    if (typeof att !== "object" || att === null) continue;
    const a = att as Record<string, unknown>;
    if (a.$type !== "space.roomy.attachment.reply.v0") continue;
    const target = a.target;
    if (typeof target !== "string" || target === "") {
      return denied(
        400,
        "InvalidRequest",
        "Reply attachment is missing a 'target' message id",
      );
    }
    const row = await db
      .query("select room from entities where id = ?")
      .get<{ room: string | null }>(target);
    if (row === null) {
      return denied(
        400,
        "InvalidRequest",
        `Reply target ${target} is not a message (no such entity)`,
      );
    }
    if (!row.room) {
      return denied(
        400,
        "InvalidRequest",
        `Reply target ${target} is not a message (no room)`,
      );
    }
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
  memo?: AccessMemo,
): Promise<WriteAuthResult> {
  const admin = await isAdmin(db, spaceId, callerDid, memo);
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

/**
 * Authorize a federation request sent on space A's stream by an admin of
 * space B. Requires: caller is a member (or admin) of the origin space A,
 * AND caller is an admin of the requesting space B (resolved via the
 * cross-space `dbResolver`). The member-of-A precondition is the documented
 * federation rule; admin-of-B ensures only B's admins can initiate.
 */
async function checkFederationRequest(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
  ctx: WriteAuthContext,
): Promise<WriteAuthResult> {
  const { accessMemo, dbResolver, globalDb } = ctx;
  const federatingSpaceDid = event.federatingSpaceDid;
  if (typeof federatingSpaceDid !== "string" || federatingSpaceDid === "") {
    return denied(
      400,
      "InvalidRequest",
      `Event is missing required 'federatingSpaceDid' field`,
    );
  }

  // Caller must be a member (or admin) of the origin space A.
  const a = ctx.access ?? (await spaceAccess(db, spaceId, callerDid, accessMemo));
  if (a.isBanned) {
    return denied(403, "Forbidden", "Caller is banned from this space");
  }
  if (!a.isMember && !a.isAdmin) {
    return denied(
      403,
      "Forbidden",
      "Caller is not a member of the target space",
    );
  }

  // Caller must be an admin of the requesting space B (cross-space).
  if (!dbResolver) {
    // Unreachable via sendEvents (which always passes openSpaceDb); defensive
    // fallback for callers that don't provide a cross-space resolver.
    return denied(
      403,
      "Forbidden",
      "Federation request requires a cross-space access check that is not configured",
    );
  }
  const bDb = dbResolver(federatingSpaceDid);
  const b = await spaceAccess(bDb, federatingSpaceDid, callerDid, accessMemo);
  if (!b.isAdmin) {
    return denied(
      403,
      "Forbidden",
      "Caller is not an admin of the requesting space",
    );
  }

  // Guard against a duplicate request: there must be no existing *live* or
  // already-decided federation for this (A, B) pair that can't be re-opened.
  // A re-request while a request is already pending is an idempotent no-op
  // (the materializer keeps it pending). A re-request after the federation was
  // removed re-establishes it (the materializer flips 'removed' back to
  // 'pending') — this is the recovery path for a torn-down federation.
  // Requesting while active/rejected is an error so the requesting admin
  // doesn't think their request will be reconsidered.
  if (globalDb) {
    const existing = await globalDb
      .query(
        "select status from space_federations where space_id = ? and federating_space_did = ?",
      )
      .get<{ status: string }>(spaceId, federatingSpaceDid);
    if (
      existing &&
      (existing.status === "active" || existing.status === "rejected")
    ) {
      return denied(
        409,
        "Conflict",
        `A federation with this space already exists (status: ${existing.status})`,
      );
    }
  }

  return undefined;
}

/**
 * Authorize a federation removal. The relationship can be torn down by an
 * admin of either side: an admin of the origin space A, or an admin of the
 * receiving space B (B may revoke its own membership at any time). `remove`
 * is sent on A's stream, so `spaceId` is A and the B-admin check needs the
 * cross-space `dbResolver`.
 */
async function checkFederationRemove(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
  ctx: WriteAuthContext,
): Promise<WriteAuthResult> {
  const { accessMemo, dbResolver } = ctx;
  // Admin of the origin space A.
  const a = ctx.access ?? (await spaceAccess(db, spaceId, callerDid, accessMemo));
  if (a.isAdmin) return undefined;

  // Admin of the receiving space B (cross-space).
  const federatingSpaceDid = event.federatingSpaceDid;
  if (typeof federatingSpaceDid === "string" && federatingSpaceDid !== "" && dbResolver) {
    const bDb = dbResolver(federatingSpaceDid);
    const b = await spaceAccess(bDb, federatingSpaceDid, callerDid, accessMemo);
    if (b.isAdmin) return undefined;
  }

  return denied(
    403,
    "Forbidden",
    "Only an admin of this space or the federated space can remove the federation",
  );
}

/**
 * Authorize a federation respond (approve/reject). Requires an admin of the
 * origin space A, and restricts the decision to a request that is actually
 * awaiting a decision. Responding to a federation that doesn't exist (404) or
 * isn't pending (409 — e.g. already active/rejected/removed) is rejected so
 * the A admin can't accidentally orphan grants (rejecting an active
 * federation) or resurrect a removed one (approving it back to active). This
 * mirrors the guard the materializer's `status = 'pending'` predicate.
 */
async function checkFederationRespond(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
  ctx: WriteAuthContext,
): Promise<WriteAuthResult> {
  const { accessMemo, globalDb } = ctx;
  // Admin of the origin space A (decisions are A's to make).
  const a = ctx.access ?? (await spaceAccess(db, spaceId, callerDid, accessMemo));
  if (!a.isAdmin) {
    return denied(
      403,
      "Forbidden",
      "Only an admin of this space can respond to a federation request",
    );
  }

  const federatingSpaceDid = event.federatingSpaceDid;
  if (typeof federatingSpaceDid !== "string" || federatingSpaceDid === "") {
    return denied(
      400,
      "InvalidRequest",
      `Event is missing required 'federatingSpaceDid' field`,
    );
  }

  if (globalDb) {
    const existing = await globalDb
      .query(
        "select status from space_federations where space_id = ? and federating_space_did = ?",
      )
      .get<{ status: string }>(spaceId, federatingSpaceDid);
    if (!existing) {
      return denied(
        404,
        "NotFound",
        "No federation request from this space to respond to",
      );
    }
    if (existing.status !== "pending") {
      return denied(
        409,
        "Conflict",
        `Cannot respond to a federation with status: ${existing.status}`,
      );
    }
  }

  return undefined;
}

/**
 * Authorize a receiver-grant write (`setReceiverPermission`, sent on B's
 * stream). Requires a B admin (via requireSpaceAdminCheck) and — when *setting*
 * a grant (permission != null) — verifies that the origin space A has actually
 * exposed the channel to B through an active origin grant. A receiver grant
 * is meaningless (and inert) without that origin grant, so blocking it
 * prevents admins from creating stale rows they can't act on. Clearing a grant
 * (permission == null) is always allowed so admins can clean up stale entries.
 */
async function checkSetReceiverPermission(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
  ctx: WriteAuthContext,
): Promise<WriteAuthResult> {
  const { globalDb } = ctx;
  // B admin of the receiving space (spaceId === B).
  const adminResult = await requireSpaceAdminCheck(db, spaceId, callerDid, ctx);
  if (adminResult) return adminResult;

  const originSpaceId = event.originSpaceId;
  const roomId = event.roomId;
  if (typeof originSpaceId !== "string" || originSpaceId === "") {
    return denied(400, "InvalidRequest", `Event is missing required 'originSpaceId' field`);
  }
  if (typeof roomId !== "string" || roomId === "") {
    return denied(400, "InvalidRequest", `Event is missing required 'roomId' field`);
  }

  // Granting (non-null) requires the origin grant to exist and be active.
  if (event.permission === null || event.permission === undefined) return undefined;
  if (!globalDb) return undefined; // defensive: no global DB -> skip origin check

  const exposed = await globalDb
    .query(
      `select 1
         from space_federations sf
         join federation_room_permissions frp
           on frp.space_id = sf.space_id
          and frp.federating_space_did = sf.federating_space_did
        where sf.space_id = ?
          and sf.federating_space_did = ?
          and sf.status = 'active'
          and frp.room_id = ?`,
    )
    .get<{ n: number }>(originSpaceId, spaceId, roomId);
  if (!exposed) {
    return denied(
      409,
      "Conflict",
      "Origin space has not exposed this channel to your space",
    );
  }

  return undefined;
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Check whether the caller is authorized to send a single event.
 *
 * `ctx.dbResolver`, when provided, returns the DB handle for another space by
 * DID — used only for the federation-request cross-space admin-of-B check.
 *
 * `ctx.serviceDid` is the appserver's own DID. When the caller matches it and
 * the event is a `SERVICE_SELF_WRITE_TYPES` member, the event is allowed
 * without space membership or admin — see that constant for the rule and its
 * limits.
 *
 * `ctx.accessMemo` is the per-request access memo. Authorizing a batch
 * through one memo is what keeps repeated checks on the same room/space off
 * the DB — callers authorizing a batch should also call
 * {@link prewarmWriteAuthAccess} first so the first room check is a batched
 * read rather than the head of an N+1.
 *
 * @returns `undefined` if allowed, or a denial object.
 */
export async function checkWriteAuth(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
  ctx: WriteAuthContext = {},
): Promise<WriteAuthResult> {
  const { access, accessMemo, dbResolver, globalDb, serviceDid } = ctx;
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

  // ── Service self-write (root of trust) ──
  // Checked before every category rule: the service is the authority those
  // rules are evaluated *by*, so it does not need standing in the space it
  // is writing to (and a ban edge on the service DID must not disable it).
  if (
    serviceDid !== undefined &&
    serviceDid !== "" &&
    callerDid === serviceDid &&
    $type in SERVICE_SELF_WRITE_TYPES
  ) {
    return undefined;
  }

  // ── Room write ──
  if (ROOM_WRITE_TYPES.has($type)) {
    const roomId = event.room;
    if (typeof roomId !== "string") {
      return denied(400, "InvalidRequest", `Event is missing required 'room' field`);
    }
    const roomResult = await requireRoomWriteCheck(db, roomId, callerDid, ctx);
    if (roomResult) return roomResult;
    return await checkReplyTargets(db, event);
  }

  // ── Message move (space admin + destination guard) ──
  if ($type === "space.roomy.message.moveMessages.v0") {
    const roomId = event.room;
    if (typeof roomId !== "string") {
      return denied(400, "InvalidRequest", `Event is missing required 'room' field`);
    }
    return await checkMoveMessages(db, spaceId, callerDid, event, ctx);
  }

  // ── Room write + author check (edit/delete) ──
  if (MESSAGE_AUTHOR_TYPES.has($type)) {
    const roomId = event.room;
    if (typeof roomId !== "string") {
      return denied(400, "InvalidRequest", `Event is missing required 'room' field`);
    }
    const roomResult = await requireRoomWriteCheck(db, roomId, callerDid, ctx);
    if (roomResult) return roomResult;

    // Additional author-or-admin check
    const messageId = event.messageId;
    if (typeof messageId !== "string") {
      return denied(400, "InvalidRequest", `Event is missing required 'messageId' field`);
    }
    const authorResult = await checkMessageAuthorOrAdmin(db, messageId, callerDid, spaceId, accessMemo);
    if (authorResult) return authorResult;
    return await checkReplyTargets(db, event);
  }

  // ── Room creation (split by kind) ──
  // Thread rooms may be created by any space member; the actual "write
  // access to the parent channel" is enforced by the paired
  // `space.roomy.link.createRoomLink.v0` event (ROOM_WRITE_TYPES), which is
  // gated on `canWrite` of the target channel and rejected atomically in the
  // same batch if the caller lacks write access. Channels/pages still
  // require space admin.
  if ($type === "space.roomy.room.createRoom.v0") {
    if (event.kind === "space.roomy.thread") {
      return await requireMembershipCheck(db, spaceId, callerDid, ctx);
    }
    return await requireSpaceAdminCheck(db, spaceId, callerDid, ctx);
  }

  // ── Room manage ──
  if (ROOM_MANAGE_TYPES.has($type)) {
    return await requireSpaceAdminCheck(db, spaceId, callerDid, ctx);
  }

  // ── Space manage ──
  if (SPACE_MANAGE_TYPES.has($type)) {
    return await requireSpaceAdminCheck(db, spaceId, callerDid, ctx);
  }

  // ── Space member ──
  if (SPACE_MEMBER_TYPES.has($type)) {
    // joinSpace only requires "not banned"
    if ($type === "space.roomy.space.joinSpace.v0") {
      return await requireNotBannedCheck(db, spaceId, callerDid, ctx);
    }
    return await requireMembershipCheck(db, spaceId, callerDid, ctx);
  }

  // ── Bridged ──
  if (BRIDGED_TYPES.has($type)) {
    return await requireSpaceAdminCheck(db, spaceId, callerDid, ctx);
  }

  // ── Channel federation ──
  if (FEDERATION_TYPES.has($type)) {
    if ($type === "space.roomy.federation.request.v0") {
      return await checkFederationRequest(db, spaceId, callerDid, event, ctx);
    }
    if ($type === "space.roomy.federation.respond.v0") {
      return await checkFederationRespond(db, spaceId, callerDid, event, ctx);
    }
    if ($type === "space.roomy.federation.setReceiverPermission.v0") {
      return await checkSetReceiverPermission(db, spaceId, callerDid, event, ctx);
    }
    // remove may be initiated by an admin of either side (A or B);
    // setRoomPermission targets the origin space (A) and requires an A admin.
    if ($type === "space.roomy.federation.remove.v0") {
      return await checkFederationRemove(db, spaceId, callerDid, event, ctx);
    }
    return await requireSpaceAdminCheck(db, spaceId, callerDid, ctx);
  }

  // Should be unreachable if ALLOWED_TYPES and the dispatch tables agree
  return denied(400, "InvalidRequest", `Unhandled event type: ${$type}`);
}

/**
 * The full set of allowed `$type` values. Exported for testing/validation.
 */
export { ALLOWED_TYPES, REJECTED_TYPES };
