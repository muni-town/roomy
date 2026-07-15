/**
 * XRPC: space.roomy.admin.getFlags (query).
 *
 * Returns the full state of every registered feature flag: key, description,
 * whether it's enabled globally, and the list of assigned DIDs.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { getAllFlagState } from "../queries/featureFlags.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface AdminGetFlagsResult {
  flags: Array<{
    key: string;
    description: string;
    globalEnabled: boolean;
    assignedDids: string[];
  }>;
}

export const adminGetFlagsHandler: QueryHandler<
  QueryParams,
  AdminGetFlagsResult
> = async (_params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const db = openDb();
  const flags = await getAllFlagState(db);
  return { flags };
};
