/**
 * XRPC: space.roomy.space.leaveSpace (procedure).
 *
 * Appends the space-side leaveSpace event AND the personal-space
 * leaveSpace event server-side, so every client leaves a space consistently
 * regardless of whether it tracks the personal space.
 *
 * @see packages/appserver/docs/plans/procedure-backlog.md
 */

import { newUlid, StreamDid, parseEvent } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { getStreamManager } from "../streams/StreamManager.ts";
import { isMember, isAdmin } from "../auth/access.ts";
import { resolvePersonalStreamDid } from "../hydration/resolvePersonalStream.ts";
import { recordLeftSpaceEdge } from "../queries/joinedSpaces.ts";
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

  const db = openDb();

  // ── Authorisation: caller must be a member or admin ──────────────────
  // The auth check doubles as the existence check: member/admin edges have
  // FKs onto entities(spaceId), so if either edge is present the space is
  // known. A bogus spaceId yields neither edge and a 403. (An older
  // `entities WHERE id = ? AND stream_id = ?` existence check was unreliable
  // because stream_id depends on which materialiser wrote the entity row
  // first — see queries/joinedSpaces.ts.)
  const member = await isMember(db, spaceId, callerDid);
  const admin = await isAdmin(db, spaceId, callerDid);
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

  // ── 2. Write personal.leaveSpace to user's personal stream ───────────
  let personalStreamDid: StreamDid | undefined;
  try {
    personalStreamDid = await resolvePersonalStreamDid(db, callerDid);
    const personalLeaveResult = parseEvent({
      id: newUlid(),
      $type: "space.roomy.space.personal.leaveSpace.v0",
      spaceDid: spaceId,
    });
    if (!personalLeaveResult.success) {
      throw new Error(`Failed to create personal.leaveSpace event: ${personalLeaveResult.error}`);
    }
    await streamManager.sendEvents(
      personalStreamDid,
      [personalLeaveResult.data],
      callerDid,
    );
  } catch (err) {
    console.warn(
      `[leaveSpace] Failed to write personal leave for ${callerDid}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // ── 4. Write leftSpace edge so the space appears with includeLeft ─────
  if (personalStreamDid) {
    await recordLeftSpaceEdge(db, spaceStreamDid, personalStreamDid);
  }

  // ── 5. Emit direct getSpaces invalidation signal ─────────────────────
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
};
