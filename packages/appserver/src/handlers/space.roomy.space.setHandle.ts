/**
 * XRPC: space.roomy.space.setHandle (procedure).
 *
 * Sets or removes a space handle for a space (DNS-based approach). The handle
 * is stored in the global DB (`space_handles`), not in the space's per-space
 * DB — it comes from the PDS/DNS, so it is not derivable from the event log
 * and must survive a replay. A `null` handle removes it.
 *
 * Requires admin access on the space.
 */

import { openGlobalDb, openSpaceDb } from "../db/db.ts";
import { upsertSpaceHandle } from "../queries/spaceHandles.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { Router as InvalidationRouter } from "../invalidation/index.ts";
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
      "Only space admins can set the space handle",
    );
  }

  // ── Persist the handle in the global store ─────────────────────────
  // The handle is assigned by the space's PDS/DNS, not by any event, so it
  // is not derived from the log and must not live in the per-space DB — a
  // space replayed from the log would lose it. Same split as user profiles:
  // authoritative in the global DB, no per-space copy.
  await upsertSpaceHandle(spaceId, handle, openGlobalDb());

  // ── Invalidate cached queries that surface the handle ───────────────
  // `getMetadata` returns the handle; `getSpaces` may surface it in the
  // space list. The handle is space-scoped (not per-user), so broadcast
  // to every viewer of this space.
  const router = InvalidationRouter.getInstance();
  if (router) {
    router.emit([
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getMetadata",
          params: { spaceId },
        },
      },
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getSpaces",
          params: {},
        },
      },
    ]);
  }
};
