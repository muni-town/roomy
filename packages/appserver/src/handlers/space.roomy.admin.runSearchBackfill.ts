/**
 * XRPC: space.roomy.admin.runSearchBackfill (procedure).
 *
 * Re-index the whole search corpus on demand. Clears every
 * `search_backfill_cursor` row (so the full corpus is re-swept — idempotent,
 * point ids are deterministic UUIDv5), then tight-loops `sweepCycle` until no
 * cursor-less spaces remain AND the last cycle was not a full batch (i.e. the
 * sparse backlog and all dense hotspots are drained).
 *
 * Why this exists: the background sweeper naps `IDLE_POLL_MS` (60s) after a
 * non-full cycle. That cadence is right when caught up, but after a reset or
 * cold start the Roomy space model is sparse — thousands of mostly-empty
 * spaces each yield a partial batch, so the background loop would crawl. This
 * endpoint drives the same sweepCycle back-to-back, so an operator can force a
 * full re-index on demand instead of waiting.
 *
 * The returned `deltaBackfilled` / `deltaFailed` are this run's contributions
 * (computed from the process-local counters, which accumulate across a boot's
 * cycles). They may under-count if the background loop also sweeps mid-run,
 * which is expected — the endpoint is a catch-up accelerator, not a precise
 * batch accounting.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { requireAdmin } from "../admin.ts";
import { openGlobalDb } from "../db/db.ts";
import { runBackfillCatchUp, searchBackfillStats } from "../search/backfill.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

export const adminRunSearchBackfillHandler: ProcedureHandler<
  Record<string, unknown>,
  {
    deltaBackfilled: number;
    deltaFailed: number;
    backfilled: number;
    failed: number;
    dbBackoffActive: boolean;
    errorCount: number;
    lastError: string | null;
  }
> = async (_params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const before = searchBackfillStats();
  const globalDb = openGlobalDb();
  await globalDb.run("delete from search_backfill_cursor");
  await runBackfillCatchUp(globalDb);
  const after = searchBackfillStats();
  return {
    deltaBackfilled: after.backfilled - before.backfilled,
    deltaFailed: after.failed - before.failed,
    backfilled: after.backfilled,
    failed: after.failed,
    dbBackoffActive: after.dbBackoffActive,
    errorCount: after.errorCount,
    lastError: after.lastError,
  };
};
