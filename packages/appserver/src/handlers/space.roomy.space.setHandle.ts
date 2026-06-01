/**
 * XRPC: space.roomy.space.setHandle (procedure).
 *
 * Sets or removes a Leaf-level handle for a space (DNS-based approach).
 * Updates the DID document with a `leaf://` alias, or removes it when
 * handle is null.
 *
 * Requires admin access on the space.
 *
 * @see packages/appserver/docs/plans/app-lite-space-handle.md
 */

import { openDb } from "../db/db.ts";
import { getServiceClient } from "../serviceClient.ts";
import { requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface SetHandleBody {
  spaceId?: unknown;
  handle?: unknown;
}

export const setHandleHandler: ProcedureHandler<SetHandleBody, void> = async (
  _params: QueryParams,
  auth: AuthCtx,
  body: SetHandleBody,
) => {
  // ── Validate input ───────────────────────────────────────────────────
  if (typeof body.spaceId !== "string" || body.spaceId === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: spaceId",
    );
  }
  if (body.handle !== undefined && body.handle !== null && typeof body.handle !== "string") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'handle' must be a string, null, or omitted",
    );
  }

  const spaceId = body.spaceId;
  const handle = body.handle !== undefined ? (body.handle as string | null) : null;
  const callerDid = auth.did;
  const db = openDb();

  // ── Require admin access ─────────────────────────────────────────────
  const access = requireSpaceAccess(db, spaceId, callerDid);
  if (!access.isAdmin) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Only space admins can set the space handle",
    );
  }

  // ── Proxy to Leaf ────────────────────────────────────────────────────
  try {
    const client = await getServiceClient();
    await client.setHandle(spaceId as any /* StreamDid */, handle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new XrpcError(500, "InternalError", `Failed to set handle: ${message}`);
  }

  // ── Persist handle in local DB for fast query access ────────────
  if (handle !== null) {
    db.run(
      `update comp_space set handle = ?, updated_at = unixepoch() * 1000 where entity = ?`,
      [handle, spaceId],
    );
  } else {
    db.run(
      `update comp_space set handle = null, updated_at = unixepoch() * 1000 where entity = ?`,
      [spaceId],
    );
  }
};
