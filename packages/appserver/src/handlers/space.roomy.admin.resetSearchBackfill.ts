/**
 * XRPC: space.roomy.admin.resetSearchBackfill (procedure).
 *
 * Clears every `search_backfill_cursor` row in the global DB so the Qdrant
 * backfill sweeper re-indexes the full corpus from the beginning (idempotent
 * — point ids are deterministic UUIDv5, so re-upserts are no-ops).
 *
 * Use after a Qdrant outage that skipped messages (e.g. the Sep 2026 507
 * incident, where the pre-fix cursor-advance bug walked past failed
 * batches). The sweeper picks up the reset on its next cycle; no restart
 * needed.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { requireAdmin } from "../admin.ts";
import { openGlobalDb } from "../db/db.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

export const adminResetSearchBackfillHandler: ProcedureHandler<
  Record<string, unknown>,
  { cleared: number }
> = async (_params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const globalDb = openGlobalDb();
  const res = await globalDb.run("delete from search_backfill_cursor");
  return { cleared: res.changes };
};
