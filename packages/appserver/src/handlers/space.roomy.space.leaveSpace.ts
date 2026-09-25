/**
 * XRPC: space.roomy.space.leaveSpace (procedure).
 *
 * Appends the space-side leaveSpace event and writes the `leftSpace` edge
 * directly so the space remains visible with `includeLeft=true`.
 *
 * @see packages/appserver/docs/plans/procedure-backlog.md
 */

import { newUlid, StreamDid, parseEvent } from "@roomy-space/sdk";
import { openGlobalDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import { getStreamManager } from "../streams/StreamManager.ts";
import { isMember, isAdmin } from "../auth/access.ts";
import {
  JOINED_SPACE_LABEL,
  LEFT_SPACE_LABEL,
  recordGlobalMembership,
  deleteGlobalMembership,
} from "../queries/joinedSpaces.ts";
import { setUserSpaceMembership } from "../queries/userSpaceMembership.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { Router as InvalidationRouter } from "../invalidation/index.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface LeaveSpaceBody {
  spaceId?: unknown;
}

export const leaveSpaceHandler: ProcedureHandler<LeaveSpaceBody, void> = async (
  _params: QueryParams,
  auth: AuthCtx,
  body: LeaveSpaceBody,
) => {
  // ── Validate input ───────────────────────────────────────────────────
  if (typeof body.spaceId !== "string" || body.spaceId === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: spaceId",
    );
  }

  const spaceId = body.spaceId;
  const callerDid = parseUserDid(auth);
  if (callerDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  const spaceDb = openSpaceDb(spaceId);

  // ── Authorisation: caller must be a member or admin ──────────────────
  // The auth check doubles as the existence check: member/admin edges have
  // FKs onto entities(spaceId), so if either edge is present the space is
  // known. A bogus spaceId yields neither edge and a 403. An
  // `entities WHERE id = ? AND stream_id = ?` existence check is unreliable
  // because stream_id depends on which materialiser wrote the entity row
  // first — see queries/joinedSpaces.ts.
  const member = await isMember(spaceDb, spaceId, callerDid);
  const admin = await isAdmin(spaceDb, spaceId, callerDid);
  if (!member && !admin) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller is not a member of this space",
    );
  }

  const spaceStreamDid = StreamDid.assert(spaceId);

  // ── 1. Send space-side leaveSpace event ──────────────────────────────
  const streamManager = getStreamManager();
  const leaveResult = parseEvent({
    id: newUlid(),
    $type: "space.roomy.space.leaveSpace.v0",
  });
  if (!leaveResult.success) {
    throw new Error(`Failed to create leaveSpace event: ${leaveResult.error}`);
  }
  await streamManager.sendEvents(
    spaceStreamDid,
    [leaveResult.data],
    callerDid,
  );

  // ── 2. Delete the joinedSpace edge (membership) ──────────────────────
  // The space-side LeaveSpace materialiser also deletes this edge (routed to
  // the global DB), but remove it here directly too for read-after-write
  // consistency in the global DB (the membership store).
  await deleteGlobalMembership(
    openGlobalDb(),
    spaceStreamDid,
    callerDid,
    JOINED_SPACE_LABEL,
  );

  // ── 3. Write leftSpace edge so the space appears with includeLeft ────
  await recordGlobalMembership(
    openGlobalDb(),
    spaceStreamDid,
    callerDid,
    LEFT_SPACE_LABEL,
  );

  // ── 3b. Durable membership intent (read-state source of truth) ──────
  await setUserSpaceMembership(
    openReadStateDb(),
    callerDid,
    spaceStreamDid,
    "left",
    "leaveSpace",
    newUlid(),
  );

  // ── 4. Emit direct getSpaces + getMetadata invalidation signals ──────

  // The live materializer also emits these when it processes the
  // leaveSpace event, but that delivery is asynchronous and may race with
  // the HTTP response. Emitting directly for the caller closes the race.
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
      // getMetadata returns isMember, which flips to false on leave.
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getMetadata",
          params: { spaceId: spaceStreamDid },
          affectedUser: callerDid,
        },
      },
    ]);
  }
};
