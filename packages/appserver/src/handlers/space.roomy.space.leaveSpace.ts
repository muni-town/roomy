/**
 * XRPC: space.roomy.space.leaveSpace (procedure).
 *
 * Appends the space-side leaveSpace event AND the personal-space
 * leaveSpace event server-side, so every client leaves a space consistently
 * regardless of whether it tracks the personal space.
 *
 * @see packages/appserver/docs/plans/procedure-backlog.md
 */

import { newUlid, UserDid, type } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { getConnectedSpace } from "../serviceClient.ts";
import { isMember, isAdmin } from "../auth/access.ts";
import { resolvePersonalStreamDid } from "../hydration/resolvePersonalStream.ts";
import { XrpcError } from "../xrpc/errors.ts";
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
  const callerDid = UserDid(auth.did);
  if (callerDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${callerDid.summary}`,
    );
  }

  const db = openDb();

  // ── Verify space exists ──────────────────────────────────────────────
  const spaceRow = db
    .query<{ n: number }, [string, string]>(
      "SELECT 1 AS n FROM entities WHERE id = ? AND stream_id = ? LIMIT 1",
    )
    .get(spaceId, spaceId);
  if (!spaceRow) {
    throw new XrpcError(404, "NotFound", `Space not found: ${spaceId}`);
  }

  // ── Authorisation: caller must be a member or admin ──────────────────
  const member = isMember(db, spaceId, callerDid);
  const admin = isAdmin(db, spaceId, callerDid);
  if (!member && !admin) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller is not a member of this space",
    );
  }

  // ── 1. Send space-side leaveSpace event ──────────────────────────────
  const space = await getConnectedSpace(spaceId as any /* StreamDid */);
  await space.sendEvent(
    {
      id: newUlid(),
      $type: "space.roomy.space.leaveSpace.v0",
    },
    callerDid,
  );

  // ── 2. Write personal.leaveSpace to user's personal stream ───────────
  try {
    const personalStreamDid = await resolvePersonalStreamDid(db, callerDid);
    const personalSpace = await getConnectedSpace(personalStreamDid);
    await personalSpace.sendEvent(
      {
        id: newUlid(),
        $type: "space.roomy.space.personal.leaveSpace.v0",
        spaceDid: spaceId as any /* StreamDid */,
      },
      callerDid,
    );
  } catch (err) {
    console.warn(
      `[leaveSpace] Failed to write personal leave for ${callerDid}:`,
      err instanceof Error ? err.message : err,
    );
  }
};
