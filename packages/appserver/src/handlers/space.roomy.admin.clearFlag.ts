/**
 * XRPC: space.roomy.admin.clearFlag (procedure).
 *
 * Reset a feature flag to its default state: disabled for everyone, no
 * per-user assignments. Deletes the flag's global row and all assignment
 * rows from the read-state DB.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import {
  requireRegisteredFlag,
  clearFlag,
} from "../queries/featureFlags.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface ClearFlagBody {
  flag?: unknown;
}

export const adminClearFlagHandler: ProcedureHandler<
  ClearFlagBody,
  void
> = async (_params: QueryParams, auth: AuthCtx, body: ClearFlagBody) => {
  requireAdmin(auth);

  if (typeof body.flag !== "string" || body.flag === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: flag",
    );
  }
  requireRegisteredFlag(body.flag);

  const db = openDb();
  await clearFlag(db, body.flag);
};
