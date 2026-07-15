/**
 * XRPC: space.roomy.admin.setFlag (procedure).
 *
 * Set a feature flag's state. Supports two independent dimensions:
 *   - `all: true` — enable the flag for ALL users (global)
 *   - `userDids: [...]` — replace the per-user DID assignment list
 *
 * Omitting a field leaves that dimension unchanged. To disable a flag
 * entirely, use `space.roomy.admin.clearFlag`.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import {
  requireRegisteredFlag,
  setFlagGlobal,
  setFlagAssignments,
} from "../queries/featureFlags.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface SetFlagBody {
  flag?: unknown;
  all?: unknown;
  userDids?: unknown;
}

export const adminSetFlagHandler: ProcedureHandler<
  SetFlagBody,
  void
> = async (_params: QueryParams, auth: AuthCtx, body: SetFlagBody) => {
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

  // Handle `all` (global enable/disable)
  if (body.all !== undefined) {
    if (typeof body.all !== "boolean") {
      throw new XrpcError(
        400,
        "InvalidRequest",
        "Field 'all' must be a boolean if provided",
      );
    }
    await setFlagGlobal(db, body.flag, body.all);
  }

  // Handle `userDids` (replace assignment list)
  if (body.userDids !== undefined) {
    if (
      !Array.isArray(body.userDids) ||
      !body.userDids.every((d) => typeof d === "string" && d.length > 0)
    ) {
      throw new XrpcError(
        400,
        "InvalidRequest",
        "Field 'userDids' must be an array of non-empty DID strings if provided",
      );
    }
    await setFlagAssignments(db, body.flag, body.userDids as string[]);
  }
};
