/**
 * XRPC: space.roomy.space.joinSpace (procedure).
 *
 * Validates invite tokens for private spaces, appends the space-side
 * joinSpace event AND the personal-space joinSpace event, so every client
 * joins consistently regardless of whether it tracks the personal space.
 *
 * @see packages/appserver/docs/plans/procedure-backlog.md
 */

import { newUlid, StreamDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { getConnectedSpace } from "../serviceClient.ts";
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
import { getOrCreateMaterializer } from "../materialization/registry.ts";
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
   * True when the appserver created a new personal stream on Leaf but
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
  // presence is enough here; Leaf is the source of truth on the join path.
  const spaceRow = db
    .query<{ n: number }, [string]>(
      "SELECT 1 AS n FROM entities WHERE id = ? LIMIT 1",
    )
    .get(spaceId);
  if (!spaceRow) {
    throw new XrpcError(404, "NotFound", `Space not found: ${spaceId}`);
  }

  // ── Ban check ────────────────────────────────────────────────────────
  if (isBanned(db, spaceId, callerDid)) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller is banned from this space",
    );
  }

  // ── Invite token validation for private spaces ───────────────────────
  const publicJoinRow = db
    .query<{ v: number }, [string]>(
      "SELECT coalesce(allow_public_join, 1) AS v FROM comp_space WHERE entity = ?",
    )
    .get(spaceId);

  const isPrivate = publicJoinRow != null && publicJoinRow.v === 0;

  if (isPrivate) {
    if (!body.inviteToken) {
      throw new XrpcError(
        403,
        "Forbidden",
        "This space requires an invite token to join",
      );
    }
    const tokenRow = db
      .query<{ n: number }, [string, string]>(
        "SELECT 1 AS n FROM comp_invite WHERE entity = ? AND token = ?",
      )
      .get(spaceId, body.inviteToken);
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
      // Create the stream on Leaf and cache the mapping; the client
      // will be instructed to save the PDS record.
      personalStreamDid = await createAndCachePersonalStream(db, callerDid);
      needsPersonalStreamRecord = true;
    } else {
      throw err;
    }
  }

  const personalSpace = await getConnectedSpace(personalStreamDid);
  await personalSpace.sendEvent(
    {
      id: newUlid(),
      $type: "space.roomy.space.personal.joinSpace.v0",
      spaceDid: spaceId as any /* StreamDid */,
    },
    callerDid,
  );

  // ── 2. Send space-side joinSpace event ───────────────────────────────
  const space = await getConnectedSpace(spaceId as any /* StreamDid */);
  await space.sendEvent(
    {
      id: newUlid(),
      $type: "space.roomy.space.joinSpace.v0",
      ...(body.inviteToken ? { inviteToken: body.inviteToken } : {}),
    },
    callerDid,
  );

  // ── 2.5. Drain the space materialiser so the membership edge is ──────
  //        materialised before we return. Without this, the client's
  //        first getMetadata after navigating into the space still sees
  //        isMember=false (the space-side joinSpace event is otherwise
  //        only materialised by the background Leaf subscription), which
  //        re-shows the "you need an invite" modal to someone who just
  //        accepted an invite.
  const spaceMat = await getOrCreateMaterializer(spaceId as any /* StreamDid */);
  await spaceMat.drain();

  // ── 3. Drain personal stream materialiser so the joinSpace event is
  //        visible to subsequent getSpaces HTTP queries ────────────────
  const personalMat = await getOrCreateMaterializer(personalStreamDid);
  await personalMat.drain();

  // ── 3.5. Remove any leftSpace edge since the user is now rejoined ────
  removeLeftSpaceEdge(db, spaceId as any /* StreamDid */, personalStreamDid);

  // ── 4. Emit direct getSpaces invalidation signal ──────────────────────
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
