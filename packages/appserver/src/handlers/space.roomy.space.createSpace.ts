import {
  newUlid,
  createDefaultSpaceEvents,
  StreamDid,
  parseEvent,
} from "@roomy-space/sdk";
import { openGlobalDb, openReadStateDb } from "../db/db.ts";
import { getStreamManager } from "../streams/StreamManager.ts";
import {
  JOINED_SPACE_LABEL,
  recordGlobalMembership,
} from "../queries/joinedSpaces.ts";
import { setUserSpaceMembership } from "../queries/userSpaceMembership.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { Router as InvalidationRouter } from "../invalidation/index.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface CreateSpaceBody {
  name?: unknown;
  description?: unknown;
  avatar?: unknown;
  allowPublicJoin?: unknown;
  allowMemberInvites?: unknown;
}

interface CreateSpaceResult {
  spaceId: string;
}

export const createSpaceHandler: ProcedureHandler<
  CreateSpaceBody,
  CreateSpaceResult
> = async (_params: QueryParams, auth: AuthCtx, body: CreateSpaceBody) => {
  // ── Validate input ───────────────────────────────────────────────────
  if (typeof body.name !== "string" || body.name.trim() === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: name",
    );
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'description' must be a string if provided",
    );
  }
  if (body.avatar !== undefined && typeof body.avatar !== "string") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'avatar' must be a string if provided",
    );
  }
  if (
    body.allowPublicJoin !== undefined &&
    typeof body.allowPublicJoin !== "boolean"
  ) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'allowPublicJoin' must be a boolean if provided",
    );
  }
  if (
    body.allowMemberInvites !== undefined &&
    typeof body.allowMemberInvites !== "boolean"
  ) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'allowMemberInvites' must be a boolean if provided",
    );
  }

  const callerDid = parseUserDid(auth);
  if (callerDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  // ── 1. Create stream locally ─────────────────────────────────────────
  const streamManager = getStreamManager();
  const spaceId = await streamManager.createStream(callerDid);

  // ── 2. Seed initial events (updateSpaceInfo, createRoom, updateSidebar)
  const seedEvents = createDefaultSpaceEvents({
    name: body.name,
    description:
      body.description !== undefined ? body.description : undefined,
    avatar: body.avatar !== undefined ? body.avatar : undefined,
    allowPublicJoin:
      body.allowPublicJoin !== undefined
        ? body.allowPublicJoin
        : undefined,
    allowMemberInvites:
      body.allowMemberInvites !== undefined
        ? body.allowMemberInvites
        : undefined,
  });
  await streamManager.sendEvents(spaceId, seedEvents, callerDid);

  // ── 3. Join as member (addAdmin already added admin edge, but not member)
  const joinResult = parseEvent({
    id: newUlid(),
    $type: "space.roomy.space.joinSpace.v0",
  });
  if (!joinResult.success) {
    throw new Error(`Failed to create joinSpace event: ${joinResult.error}`);
  }
  await streamManager.sendEvents(
    spaceId,
    [joinResult.data],
    callerDid,
  );

  // ── 4. Record the membership in the local DB ────────────────────────
  // getSpaces identifies joined spaces by a `joinedSpace` edge (head =
  // caller DID). Membership lives in the global DB, so the edge is written
  // there directly for read-after-write consistency before the materialiser
  // lands. Idempotent.
  await recordGlobalMembership(
    openGlobalDb(),
    spaceId,
    callerDid,
    JOINED_SPACE_LABEL,
  );
  // Durable membership intent (read-state source of truth).
  await setUserSpaceMembership(
    openReadStateDb(),
    callerDid,
    spaceId,
    "joined",
    "createSpace",
    newUlid(),
  );

  // ── 5. Emit direct getSpaces + getMetadata invalidation signals ──────
  // The live materializer also emits these when it processes the
  // joinSpace event, but that delivery is asynchronous and may race with
  // the HTTP response. Emitting directly ensures the sync client receives
  // the signal immediately.
  const router = InvalidationRouter.getInstance();
  if (router) {
    router.emit([
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getSpaces",
          params: {},
          affectedUser: callerDid,
        },
      },
      // getMetadata returns isMember/isAdmin, which flips to true on join.
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getMetadata",
          params: { spaceId },
          affectedUser: callerDid,
        },
      },
    ]);
  }

  return { spaceId };
};
