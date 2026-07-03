import {
  newUlid,
  createDefaultSpaceEvents,
  StreamDid,
  parseEvent,
} from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { getStreamManager } from "../streams/StreamManager.ts";
import {
  PersonalStreamRecordNotFound,
  createAndCachePersonalStream,
  resolvePersonalStreamDid,
} from "../hydration/resolvePersonalStream.ts";
import { recordPersonalSpaceMembership } from "../queries/joinedSpaces.ts";
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
  /** The personal stream DID, if one was created on-the-fly. */
  personalStreamDid?: string;
  /**
   * True when the appserver created a new personal stream locally but
   * could not write the PDS record on the user's behalf. The client should
   * call `savePersonalStreamId` to persist the mapping.
   */
  needsPersonalStreamRecord?: boolean;
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

  // ── 4. Write personal.joinSpace to creator's personal stream ─────────
  const db = openDb();
  let personalStreamDid: StreamDid;
  let needsPersonalStreamRecord = false;
  try {
    personalStreamDid = await resolvePersonalStreamDid(db, callerDid);
  } catch (err) {
    if (err instanceof PersonalStreamRecordNotFound) {
      // New user without a personal stream record on their PDS.
      // Create a local personal stream and cache the mapping; the client
      // will be instructed to save the PDS record.
      personalStreamDid = await createAndCachePersonalStream(db, callerDid);
      needsPersonalStreamRecord = true;
    } else {
      throw err;
    }
  }

  const personalJoinResult = parseEvent({
    id: newUlid(),
    $type: "space.roomy.space.personal.joinSpace.v0",
    spaceDid: spaceId,
  });
  if (!personalJoinResult.success) {
    throw new Error(`Failed to create personal.joinSpace event: ${personalJoinResult.error}`);
  }
  await streamManager.sendEvents(
    personalStreamDid,
    [personalJoinResult.data],
    callerDid,
  );

  // ── 4b. Record the membership in the local DB ────────────────────────
  // getSpaces identifies joined spaces by a `joinedSpace` edge from the
  // caller's personal stream. The personal stream's live materialisation of
  // the personal.joinSpace event above writes that edge too, but may not
  // have landed by the time this HTTP response returns — so write it
  // directly. Idempotent w.r.t. the later live materialisation.
  await recordPersonalSpaceMembership(db, spaceId, personalStreamDid);

  // ── 5. Emit direct getSpaces invalidation signal ──────────────────────
  // The personal stream materializer will also emit this signal when it
  // processes the personal.joinSpace event via its live subscription, but
  // that delivery is asynchronous and may race with the HTTP response.
  // Emitting directly ensures the sync client receives the signal
  // immediately.
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
    ]);
  }

  return { spaceId, personalStreamDid, needsPersonalStreamRecord };
};
