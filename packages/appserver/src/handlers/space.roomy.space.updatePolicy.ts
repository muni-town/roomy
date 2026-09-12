/**
 * XRPC: space.roomy.space.updatePolicy (procedure).
 *
 * Re-applies the reference arbiter config on a space's stewarded account.
 * Requires admin access on the space. The appserver, acting as the arbiter's
 * recovery admin for every stewarded space, calls
 * `town.muni.arbiter.resetConfig` with the reference config — the same
 * config newly-provisioned spaces get (`REFERENCE_ARBITER_CONFIG`). This
 * repairs an existing space's config (e.g. after the arbiter's config model
 * changed) without touching anything else on the account.
 *
 * When the arbiter is not configured, the procedure is a no-op success —
 * there is no stewarded account to update.
 */

import { openSpaceDb } from "../db/db.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { getStreamManager } from "../streams/StreamManager.ts";
import { resetConfig } from "../arbiter/client.ts";
import { REFERENCE_ARBITER_CONFIG } from "../arbiter/provision.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface UpdatePolicyBody {
  spaceId?: unknown;
}

export const updatePolicyHandler: ProcedureHandler<UpdatePolicyBody, void> = async (
  _params: QueryParams,
  auth: AuthCtx,
  body: UpdatePolicyBody,
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
  const db = openSpaceDb(spaceId);

  // ── Require admin access ─────────────────────────────────────────────
  const access = await requireSpaceAccess(db, spaceId, callerDid);
  if (!access.isAdmin) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Only space admins can update the space's policy",
    );
  }

  // ── Re-apply the reference config on the stewarded account ──────────
  const streamManager = getStreamManager();
  const arbiter = streamManager.arbiter;
  if (arbiter) {
    // The appserver is the recovery admin for every stewarded account, so it
    // may reset the config. `resetConfig` throws ArbiterError on failure.
    await resetConfig(arbiter, streamManager.ownDid, spaceId, REFERENCE_ARBITER_CONFIG);
  }
  // No arbiter configured → no stewarded account to update (no-op).
};
