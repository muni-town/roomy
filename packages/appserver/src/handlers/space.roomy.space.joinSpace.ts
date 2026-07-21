/**
 * XRPC: space.roomy.space.joinSpace (procedure).
 *
 * Validates invite tokens for private spaces, appends the space-side
 * joinSpace event AND the personal-space joinSpace event, so every client
 * joins consistently regardless of whether it tracks the personal space.
 *
 * @see packages/appserver/docs/plans/procedure-backlog.md
 */

import { newUlid, StreamDid, parseEvent } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { getStreamManager } from "../streams/StreamManager.ts";
import { isBanned } from "../auth/access.ts";
import {
  PersonalStreamRecordNotFound,
  createAndCachePersonalStream,
  resolvePersonalStreamDid,
} from "../hydration/resolvePersonalStream.ts";
import { removeLeftSpaceEdge } from "../queries/joinedSpaces.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { Router as InvalidationRouter } from "../invalidation/index.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface JoinSpaceBody {
  spaceId?: unknown;
  inviteToken?: unknown;
}

interface JoinSpaceResult {
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

export const joinSpaceHandler: ProcedureHandler<
  JoinSpaceBody,
  JoinSpaceResult
> = async (_params: QueryParams, auth: AuthCtx, body: JoinSpaceBody) => {
  // ── Validate input ───────────────────────────────────────────────────
  if (typeof body.spaceId !== "string" || body.spaceId === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: spaceId",
    );
  }
  if (
    body.inviteToken !== undefined &&
    typeof body.inviteToken !== "string"
  ) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'inviteToken' must be a string if provided",
    );
  }

  const spaceId = body.spaceId;
  const callerDid = parseUserDid(auth);
  if (callerDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  const db = openDb();

  // ── Verify space exists ──────────────────────────────────────────────
  // `entities.stream_id` isn't a reliable space-identity check — when both
  // a personal stream and the space itself materialise it, the first writer
  // wins and the value depends on event ordering. The entity row's mere
  // presence is enough here; the space stream itself is the source of truth on the join path.
  const spaceRow = await db
    .query(
      "SELECT 1 AS n FROM entities WHERE id = ? LIMIT 1",
    )
    .get<{ n: number }>(spaceId);
  if (!spaceRow) {
    throw new XrpcError(404, "NotFound", `Space not found: ${spaceId}`);
  }

  // ── Ban check ────────────────────────────────────────────────────────
  if (await isBanned(db, spaceId, callerDid)) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller is banned from this space",
    );
  }

  // ── Invite token validation for private spaces ───────────────────────
  const publicJoinRow = await db
    .query(
      "SELECT coalesce(allow_public_join, 1) AS v FROM comp_space WHERE entity = ?",
    )
    .get<{ v: number }>(spaceId);

  const isPrivate = publicJoinRow != null && publicJoinRow.v === 0;

  if (isPrivate) {
    if (!body.inviteToken) {
      throw new XrpcError(
        403,
        "Forbidden",
        "This space requires an invite token to join",
      );
    }
    const tokenRow = await db
    .query(
      "SELECT 1 AS n FROM comp_invite WHERE entity = ? AND token = ?",
    )
    .get<{ n: number }>(spaceId, body.inviteToken);
    if (!tokenRow) {
      throw new XrpcError(403, "Forbidden", "Invalid invite token");
    }
  }

  // ── 1. Resolve or create personal stream ──────────────────────────────
  // Must succeed before the space-side join so we don't end up in a
  // state where the user has joined the space but can't see it in their
  // space list.
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

  const streamManager = getStreamManager();

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

  // ── 2. Send space-side joinSpace event ───────────────────────────────
  const spaceJoinResult = parseEvent({
    id: newUlid(),
    $type: "space.roomy.space.joinSpace.v0",
    ...(body.inviteToken ? { inviteToken: body.inviteToken } : {}),
  });
  if (!spaceJoinResult.success) {
    throw new Error(`Failed to create joinSpace event: ${spaceJoinResult.error}`);
  }
  const spaceStreamDid = StreamDid.assert(spaceId);
  await streamManager.sendEvents(
    spaceStreamDid,
    [spaceJoinResult.data],
    callerDid,
  );

  // ── 3.5. Remove any leftSpace edge since the user is now rejoined ────
  await removeLeftSpaceEdge(db, spaceStreamDid, personalStreamDid);

  // ── 4. Emit direct getSpaces + getMetadata invalidation signals ──────
  // The personal stream materializer also emits these when it processes
  // the personal.joinSpace event, but that delivery is asynchronous and
  // may race with the HTTP response. Emitting directly for the caller
  // closes the race window.
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

  return { spaceId, personalStreamDid, needsPersonalStreamRecord };
};
