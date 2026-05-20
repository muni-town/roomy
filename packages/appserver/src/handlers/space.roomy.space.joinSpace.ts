/**
 * XRPC: space.roomy.space.joinSpace (procedure).
 *
 * Validates invite tokens for private spaces, appends the space-side
 * joinSpace event AND the personal-space joinSpace event, so every client
 * joins consistently regardless of whether it tracks the personal space.
 *
 * @see packages/appserver/docs/plans/procedure-backlog.md
 */

import { newUlid, UserDid, type } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { getConnectedSpace } from "../serviceClient.ts";
import { isBanned } from "../auth/access.ts";
import { resolvePersonalStreamDid } from "../hydration/resolvePersonalStream.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface JoinSpaceBody {
  spaceId?: unknown;
  inviteToken?: unknown;
}

export const joinSpaceHandler: ProcedureHandler<
  JoinSpaceBody,
  { spaceId: string }
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

  // ── 1. Send space-side joinSpace event ───────────────────────────────
  const space = await getConnectedSpace(spaceId as any /* StreamDid */);
  await space.sendEvent(
    {
      id: newUlid(),
      $type: "space.roomy.space.joinSpace.v0",
      ...(body.inviteToken ? { inviteToken: body.inviteToken } : {}),
    },
    callerDid,
  );

  // ── 2. Write personal.joinSpace to user's personal stream ────────────
  try {
    const personalStreamDid = await resolvePersonalStreamDid(db, callerDid);
    const personalSpace = await getConnectedSpace(personalStreamDid);
    await personalSpace.sendEvent(
      {
        id: newUlid(),
        $type: "space.roomy.space.personal.joinSpace.v0",
        spaceDid: spaceId as any /* StreamDid */,
      },
      callerDid,
    );
  } catch (err) {
    console.warn(
      `[joinSpace] Failed to write personal join for ${callerDid}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return { spaceId };
};
