/**
 * Appserver boot entry point.
 *
 * Constructs the server via `createAppserver` (see `./appserver.ts`) with
 * env-derived options, then starts Leaf backfill. The factory handles all
 * server construction — DBs, routes, CORS, health endpoints, WebSocket —
 * so this file is only the process entry point and the backfill driver.
 */

import { createAppserver, type AppserverHandle } from "./appserver.ts";
import { RoomyServiceClient, StreamDid } from "@roomy-space/sdk";
import { getServiceClient } from "./serviceClient.ts";
import { getOrCreateMaterializer, removeMaterializer } from "./materialization/registry.ts";
import { log } from "./log.ts";
import { withTimeout } from "./timeout.ts";

// ─── Config (env) ──────────────────────────────────────────────────────────

const BACKFILL_MODE = process.env.APPSERVER_BACKFILL_MODE ?? "eager";

/**
 * Parse a positive-integer env var, falling back to `def` (and warning on
 * invalid input). Centralises the validating pattern used by the backfill knobs
 * below so garbage env values fail closed to the default instead of silently
 * coercing to NaN (which would otherwise break the breaker math and backoff
 * schedule). `min` defaults to 1; pass 0 to allow disabling a knob.
 */
function envInt(name: string, def: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min) return n;
  console.warn(`[startup] invalid ${name} "${raw}", using ${def}`);
  return def;
}

// Max spaces materialised concurrently during eager startup backfill (default
// 4). Spaces' Leaf subscriptions and profile fetches overlap; SQLite writes
// still serialize on the single WAL writer, so this mostly overlaps network
// I/O. Lower it if Leaf or the appview struggles under load.
//
// Default lowered from 8 → 4: in production, 8 workers drove connect+subscribe
// at ~11/s and wedged the Leaf server at ~885 streams (every subsequent
// connect then timed out at 30s). 4 ≈ halves the sustained pressure while still
// overlapping Leaf I/O; tune via env. Pair with the circuit breaker below,
// which backs off when Leaf is unresponsive so a wedged backend isn't
// hammered.
const BACKFILL_CONCURRENCY = envInt("APPSERVER_BACKFILL_CONCURRENCY", 4);

/**
 * Backfill circuit breaker. When a worker's consecutive failures exceed
 * `APPSERVER_BACKFILL_FAILURE_THRESHOLD`, it pauses for an exponentially-growing
 * backoff (capped at `APPSERVER_BACKFILL_BACKOFF_MAX_MS`) before pulling the
 * NEXT stream. This is the fix for the Leaf-wedge feedback loop: without it, a
 * wedged Leaf caused every remaining stream to time out at 30s, churning
 * through the whole queue with zero progress and ~3 log lines per failure
 * (breaching platform rate limits). With the breaker:
 *   - a sustained Leaf outage → workers back off (5s→10s→…→60s) between
 *     attempts, dropping pressure on Leaf and quieting the log flood;
 *   - the instant Leaf recovers, a worker's next attempt succeeds, the streak
 *     resets, and full-speed backfill resumes.
 *
 * Failed streams are SKIPPED, not retried in-place: the worker advances past
 * them and they leave the startup queue. They are NOT lost — the catch path
 * calls `removeMaterializer`, so the next user query for that space hits
 * `getOrCreateMaterializer` with an empty cache and builds a fresh materializer
 * on demand (the same lazy path `lazy` mode uses). Startup backfill is
 * best-effort bulk warm-up; correctness is ensured by on-demand
 * re-materialisation.
 *
 * `backfillStatus.started` is a loop cursor: it's incremented once per
 * iteration at the top of the loop (before the try/catch), so it reaches
 * `total` once every stream has been *attempted*, not only the successful
 * ones. During an outage it does NOT freeze — each failed streak still
 * advances it. `succeeded`/`failed` are the honest signals; read
 * `/health/backfill` as: `succeeded` climbing = real progress; `failed`
 * climbing while `succeeded` stalls = Leaf is down.
 */
const BACKFILL_FAILURE_THRESHOLD = envInt(
  "APPSERVER_BACKFILL_FAILURE_THRESHOLD",
  3,
);
const BACKFILL_BACKOFF_MS = envInt("APPSERVER_BACKFILL_BACKOFF_MS", 5_000);
const BACKFILL_BACKOFF_MAX_MS = envInt("APPSERVER_BACKFILL_BACKOFF_MAX_MS", 60_000);

/**
 * Emit `[startup] progress …` every N completed spaces (default 50), plus on
 * the final completion. With thousands of streams a per-DID progress line
 * floods logs and trips platform rate limits (e.g. Railway's 500 logs/sec);
 * this turns ~N lines into ~N/50. Set to 1 to restore per-DID progress.
 */
const BACKFILL_PROGRESS_EVERY = envInt("APPSERVER_BACKFILL_PROGRESS_EVERY", 50);

/**
 * Timeout for `mat.close()` during startup backfill (drain + Leaf
 * unsubscribe). `close()` isn't bounded by the SDK, so a Leaf that dies right
 * after backfill finished would otherwise hang the worker in unsubscribe and
 * re-stall the bounded pipeline. On timeout the worker abandons cleanup and
 * moves on (the materializer is removed from the registry either way).
 *
 * Caveat: `withTimeout` does NOT cancel the underlying `close()` (Promises
 * aren't cancellable), so a timed-out close() keeps running in the background
 * with its Leaf subscription still open. During a sustained Leaf outage these
 * abandoned subscriptions can accumulate until Leaf recovers and the pending
 * unsubscribes finally settle. Correctness is unaffected (the materializer is
 * evicted from the registry), but operators should be aware subscriptions may
 * leak transiently under outage + timeout.
 */
const CLOSE_TIMEOUT_MS = envInt("APPSERVER_BACKFILL_CLOSE_TIMEOUT_MS", 15_000);

// ─── Server construction ───────────────────────────────────────────────────

const app: AppserverHandle = createAppserver({
  backfillMode: BACKFILL_MODE as "eager" | "lazy" | "disabled",
});

// ─── Startup backfill ──────────────────────────────────────────────────
// After the server is listening, backfill Leaf streams into SQLite. In the
// default `eager` mode we discover every network stream and materialise it
// up front so all spaces are ready when users connect; in `lazy` mode we
// skip startup entirely and let the materializer registry materialise each
// space on first request (the original pattern).
//
// Eager backfill is intentionally fire-and-forget: the server is already
// accepting requests, and materializers will catch up asynchronously. If
// Leaf is unreachable at startup, the service client will be lazily retried
// on the first admin/materializeSpace call (or on first request in lazy
// mode) — spaces are never unavailable, just possibly stale until backfill
// completes, after which invalidation signals fill in the rest.
if (BACKFILL_MODE === "lazy") {
  log.info("startup", "lazy mode — skipping eager backfill");
} else {
  startupBackfill(app).catch((err) => {
    console.error("[startup] backfill failed:", err);
  });
}

async function startupBackfill(app: AppserverHandle): Promise<void> {
  const serviceClient = await getServiceClient();

  const allStreams: StreamDid[] = [];
  const items = await serviceClient.listStreams();
  for (const s of items) {
    allStreams.push(StreamDid.assert(s.did));
  }

  const total = allStreams.length;
  app.backfillStatus.discovered = total;
  log.info("startup", `discovered ${total} streams`);

  if (total === 0) {
    app.backfillStatus.done = true;
    return;
  }

  // Bounded concurrency: process streams in a fixed-size worker pool.
  let idx = 0;
  const errors: Array<{ stream: StreamDid; error: unknown }> = [];

  async function worker(): Promise<void> {
    while (idx < total) {
      const i = idx++;
      const streamDid = allStreams[i]!;
      app.backfillStatus.started++;

      let consecutiveFailures = 0;
      let backoff = BACKFILL_BACKOFF_MS;

      while (true) {
        try {
          const mat = await getOrCreateMaterializer(streamDid);
          await mat.close();
          app.backfillStatus.succeeded++;
          consecutiveFailures = 0;
          break;
        } catch (err) {
          consecutiveFailures++;
          errors.push({ stream: streamDid, error: err });
          app.backfillStatus.failed++;

          if (consecutiveFailures >= BACKFILL_FAILURE_THRESHOLD) {
            log.info(
              "startup",
              `breaker opened for ${streamDid} after ${consecutiveFailures} failures, backing off ${backoff}ms`,
            );
            await new Promise((resolve) => setTimeout(resolve, backoff));
            backoff = Math.min(backoff * 2, BACKFILL_BACKOFF_MAX_MS);
            consecutiveFailures = 0;
          }

          removeMaterializer(streamDid);
        }
      }

      app.backfillStatus.completed++;
      if (
        app.backfillStatus.completed % BACKFILL_PROGRESS_EVERY === 0 ||
        app.backfillStatus.completed === total
      ) {
        log.info(
          "startup",
          `progress ${app.backfillStatus.completed}/${total} (${app.backfillStatus.succeeded} ok, ${app.backfillStatus.failed} failed)`,
        );
      }
    }
  }

  const workers = Array.from({ length: BACKFILL_CONCURRENCY }, () => worker());
  await Promise.all(workers);

  app.backfillStatus.done = true;
  log.info(
    "startup",
    `backfill complete: ${app.backfillStatus.succeeded} succeeded, ${app.backfillStatus.failed} failed`,
  );
}
