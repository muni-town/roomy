import { XrpcRouter, prodAuthVerifier } from "./xrpc/index.ts";
import { Router as InvalidationRouter } from "./invalidation/index.ts";
import { setInvalidationRouter } from "./materialization/registry.ts";
import { startEmbedSweeper, embedSweeperStats } from "./embed/sweeper.ts";
import { countPendingLinks } from "./embed/enricher.ts";
import { log } from "./log.ts";
import { withTimeout } from "./timeout.ts";
import { openDb } from "./db/db.ts";
import { attachReadState, openReadStateDb } from "./db/readStateDb.ts";
import { purgeStaleThreadActivity } from "./queries/userActiveThreads.ts";
import { getConnectionTicketHandler } from "./handlers/space.roomy.auth.getConnectionTicket.ts";
import { createSyncSubscribeHandler } from "./handlers/space.roomy.sync.subscribe.ts";
import { connectSpaceHandler } from "./handlers/space.roomy.admin.connectSpace.ts";
import { materializeSpaceHandler } from "./handlers/space.roomy.admin.materializeSpace.ts";
import { getSpacesHandler } from "./handlers/space.roomy.space.getSpaces.ts";
import { getMembersHandler } from "./handlers/space.roomy.space.getMembers.ts";
import { getMetadataHandler } from "./handlers/space.roomy.space.getMetadata.ts";
import { getSpaceThreadsHandler } from "./handlers/space.roomy.space.getThreads.ts";
import { getRolesHandler } from "./handlers/space.roomy.space.getRoles.ts";
import { getInvitesHandler } from "./handlers/space.roomy.space.getInvites.ts";
import { getRoomMetadataHandler } from "./handlers/space.roomy.room.getMetadata.ts";
import { getRoomThreadsHandler } from "./handlers/space.roomy.room.getThreads.ts";
import { getMessagesHandler } from "./handlers/space.roomy.room.getMessages.ts";
import { getMessageHandler } from "./handlers/space.roomy.message.getMessage.ts";
import { getReactionsHandler } from "./handlers/space.roomy.message.getReactions.ts";
import { updateSeenHandler } from "./handlers/space.roomy.room.updateSeen.ts";
import { sendEventsHandler } from "./handlers/space.roomy.space.sendEvents.ts";
import { createSpaceHandler } from "./handlers/space.roomy.space.createSpace.ts";
import { joinSpaceHandler } from "./handlers/space.roomy.space.joinSpace.ts";
import { leaveSpaceHandler } from "./handlers/space.roomy.space.leaveSpace.ts";
import { setHandleHandler } from "./handlers/space.roomy.space.setHandle.ts";
import { getActivityFeedHandler } from "./handlers/space.roomy.space.getActivityFeed.ts";
import { RoomyServiceClient, schemas, StreamDid } from "@roomy-space/sdk";
import { getServiceClient } from "./serviceClient.ts";
import { getOrCreateMaterializer, removeMaterializer } from "./materialization/registry.ts";
import { proxyBlob } from "./blob.ts";

const PORT = Number(process.env.PORT ?? 8080);
const OWN_DID = process.env.APPSERVER_DID ?? "did:web:api.roomy.space";
const SERVICE_ENDPOINT =
  process.env.APPSERVER_ORIGIN ?? "https://api.roomy.space";

// When to backfill Leaf streams into SQLite. `eager` (default) discovers and
// materialises every network stream at boot; `lazy` defers until first request
// via the materializer registry / user hydration path. See `startupBackfill()`.
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

/**
 * Live startup-backfill status, exposed at `GET /health/backfill` so operators
 * can watch progress without scraping (rate-limited) logs. Mutated by
 * `startupBackfill()`; `done` flips true when the run finishes (success or
 * failure). In `lazy` mode `discovered` stays 0 and `done` is false — spaces
 * materialise on first request instead.
 */
const backfillStatus = {
  mode: BACKFILL_MODE,
  discovered: 0,
  started: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  done: false,
};

const DID_DOCUMENT = {
  "@context": ["https://www.w3.org/ns/did/v1"],
  id: OWN_DID,
  service: [
    {
      id: "#space_roomy_appserver",
      type: "RoomyAppserver",
      serviceEndpoint: SERVICE_ENDPOINT,
    },
  ],
};

// ─── Databases ──────────────────────────────────────────────────────────
// Materialisation DB (derived from Leaf, can be wiped + re-backfilled).
const mainDb = openDb();
// Read-state DB (appserver-owned, survives materialisation resets).
const readStateDb = openReadStateDb();
// ATTACH read-state to main DB so SQL can reference readstate.read_positions.
attachReadState(mainDb, readStateDb);

// ─── Periodic maintenance ──────────────────────────────────────────────
// Purge stale user_thread_activity rows older than 72 hours once per hour.
setInterval(() => {
  const cutoff = Date.now() - 72 * 60 * 60 * 1000;
  const purged = purgeStaleThreadActivity(mainDb, cutoff);
  if (purged > 0) {
    console.log(`[maintenance] purged ${purged} stale user_thread_activity rows`);
  }
}, 60 * 60 * 1000); // 1 hour

// ─── Invalidation + Sync ────────────────────────────────────────────────
// Singleton router — live events flow through every SpaceMaterializer
// created by the registry into this router, then out to the SyncManager
// which routes frames to WS connections.
const invalidationRouter = new InvalidationRouter();
InvalidationRouter.setInstance(invalidationRouter);
setInvalidationRouter(invalidationRouter);

// Start the centralized embed enrichment sweeper. One process-wide loop
// drains all pending link embeds (deduplicated + timeout-bounded) instead
// of each SpaceMaterializer fetching independently. See embed/sweeper.ts.
startEmbedSweeper({ db: mainDb, invalidationRouter });

const syncSubscribeHandler = createSyncSubscribeHandler(invalidationRouter);

// ─── XRPC routes ────────────────────────────────────────────────────────

const router = new XrpcRouter(prodAuthVerifier)
  .procedure("space.roomy.auth.getConnectionTicket", {
    handler: getConnectionTicketHandler,
    inputSchema: schemas.procedures.getConnectionTicket.Input,
    outputSchema: schemas.procedures.getConnectionTicket.Output,
  })
  .procedure("space.roomy.room.updateSeen", {
    handler: updateSeenHandler,
    inputSchema: schemas.procedures.updateSeen.Input,
    // No outputSchema: void return; short-circuits to 200 with empty body.
  })
  .procedure("space.roomy.space.sendEvents", {
    handler: sendEventsHandler,
    inputSchema: schemas.procedures.sendEvents.Input,
    // No outputSchema: void return; short-circuits to 200 with empty body.
  })
  .procedure("space.roomy.space.createSpace", {
    handler: createSpaceHandler,
    inputSchema: schemas.procedures.createSpace.Input,
    outputSchema: schemas.procedures.createSpace.Output,
  })
  .procedure("space.roomy.space.joinSpace", {
    handler: joinSpaceHandler,
    inputSchema: schemas.procedures.joinSpace.Input,
    outputSchema: schemas.procedures.joinSpace.Output,
  })
  .procedure("space.roomy.space.leaveSpace", {
    handler: leaveSpaceHandler,
    inputSchema: schemas.procedures.leaveSpace.Input,
    // No outputSchema: void return; short-circuits to 200 with empty body.
  })
  .procedure("space.roomy.space.setHandle", {
    handler: setHandleHandler,
    inputSchema: schemas.procedures.setHandle.Input,
    // No outputSchema: void return; short-circuits to 200 with empty body.
  })
  // Admin routes (connectSpace, materializeSpace) intentionally have no
  // arktype schemas — they're internal/admin endpoints not part of the
  // public XRPC interface spec.
  .query("space.roomy.admin.connectSpace", {
    handler: connectSpaceHandler,
  })
  .query("space.roomy.admin.materializeSpace", {
    handler: materializeSpaceHandler,
  })
  .query("space.roomy.space.getSpaces", {
    handler: getSpacesHandler,
    paramsSchema: schemas.queries.getSpaces.Params,
    outputSchema: schemas.queries.getSpaces.Response,
  })
  .query("space.roomy.space.getActivityFeed", {
    handler: getActivityFeedHandler,
    paramsSchema: schemas.queries.getActivityFeed.Params,
    outputSchema: schemas.queries.getActivityFeed.Response,
  })
  .query("space.roomy.space.getMembers", {
    handler: getMembersHandler,
    paramsSchema: schemas.queries.getMembers.Params,
    outputSchema: schemas.queries.getMembers.Response,
  })
  .query("space.roomy.space.getMetadata", {
    handler: getMetadataHandler,
    paramsSchema: schemas.queries.getSpaceMetadata.Params,
    outputSchema: schemas.queries.getSpaceMetadata.Response,
  })
  .query("space.roomy.space.getThreads", {
    handler: getSpaceThreadsHandler,
    paramsSchema: schemas.queries.getSpaceThreads.Params,
    outputSchema: schemas.queries.getSpaceThreads.Response,
  })
  .query("space.roomy.space.getRoles", {
    handler: getRolesHandler,
    paramsSchema: schemas.queries.getRoles.Params,
    outputSchema: schemas.queries.getRoles.Response,
  })
  .query("space.roomy.space.getInvites", {
    handler: getInvitesHandler,
    paramsSchema: schemas.queries.getInvites.Params,
    outputSchema: schemas.queries.getInvites.Response,
  })
  .query("space.roomy.room.getMetadata", {
    handler: getRoomMetadataHandler,
    paramsSchema: schemas.queries.getRoomMetadata.Params,
    outputSchema: schemas.queries.getRoomMetadata.Response,
  })
  .query("space.roomy.room.getThreads", {
    handler: getRoomThreadsHandler,
    paramsSchema: schemas.queries.getRoomThreads.Params,
    outputSchema: schemas.queries.getRoomThreads.Response,
  })
  .query("space.roomy.room.getMessages", {
    handler: getMessagesHandler,
    paramsSchema: schemas.queries.getMessages.Params,
    outputSchema: schemas.queries.getMessages.Response,
  })
  .query("space.roomy.message.getMessage", {
    handler: getMessageHandler,
    paramsSchema: schemas.queries.getMessage.Params,
    outputSchema: schemas.queries.getMessage.Response,
  })
  .query("space.roomy.message.getReactions", {
    handler: getReactionsHandler,
  })
  .sync("space.roomy.sync.subscribe", {
    handler: syncSubscribeHandler,
  });

// ─── Server ─────────────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN ?? "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Atproto-Proxy",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Bun.serve({
  port: PORT,
  // Backfill of large spaces (tens of thousands of events) can take
  // significantly longer than Bun's default 10s. Hydration no longer
  // blocks on backfill completion (see userHydration.ts), but the admin
  // materializeSpace handler with wait=backfill may legitimately take
  // a long time. Set a generous idle timeout so those requests don't
  // get killed mid-flight.
  // 255s is Bun's hard maximum idleTimeout — set to that ceiling so a long
  // admin materializeSpace (wait=backfill on a huge space) isn't killed.
  idleTimeout: 255, // seconds — Bun's hard max
  fetch: async (req, server) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(req.url);

    if (url.pathname === "/.well-known/did.json") {
      return new Response(JSON.stringify(DID_DOCUMENT), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    // ─── Health endpoints ──────────────────────────────────────────────
    // Unauthenticated (liveness/readiness must not require auth) and cheap,
    // so operators can monitor the appserver without scraping rate-limited
    // stdout. Each returns JSON with CORS so a browser dashboard can poll.
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          uptime: process.uptime(),
          did: OWN_DID,
          port: PORT,
          backfillDone: backfillStatus.done,
        }),
        { headers: { "content-type": "application/json", ...corsHeaders } },
      );
    }
    if (url.pathname === "/health/backfill") {
      return new Response(JSON.stringify(backfillStatus), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }
    if (url.pathname === "/health/embed") {
      const stats = embedSweeperStats();
      let pending: number;
      try {
        pending = countPendingLinks(mainDb);
      } catch {
        pending = -1; // DB read failed — surface the error state, don't 500
      }
      return new Response(
        JSON.stringify({ ...stats, pending }),
        { headers: { "content-type": "application/json", ...corsHeaders } },
      );
    }

    // ─── Blob proxy ────────────────────────────────────────────────────
    // `atblob://<did>/<cid>` → raw bytes from the blob owner's PDS.
    // Public (no auth): blobs referenced in public records are public and
    // content-addressed by CID. Needed for non-image media (video, files)
    // because cdn.bsky.app only serves images.
    const blobMatch = url.pathname.match(/^\/blob\/(.+?)\/(.+)$/);
    if (blobMatch && req.method === "GET") {
      const did = decodeURIComponent(blobMatch[1]!);
      const cid = decodeURIComponent(blobMatch[2]!);
      const res = await proxyBlob(did, cid, req);
      console.log(`${req.method} ${url.pathname} → ${res.status}`);
      for (const [k, v] of Object.entries(corsHeaders)) {
        res.headers.set(k, v);
      }
      return res;
    }

    const res = await router.fetch(req, server);
    if (res === undefined) {
      // Successful WebSocket upgrade — no HTTP response to send.
      console.log(`${req.method} ${url.pathname} → [ws upgrade]`);
      return undefined;
    }
    const status = res.status;
    console.log(`${req.method} ${url.pathname} → ${status}`);
    for (const [k, v] of Object.entries(corsHeaders)) {
      res.headers.set(k, v);
    }
    return res;
  },
  websocket: router.websocket,
});

console.log(`Appserver listening on port ${PORT} (DID: ${OWN_DID})`);

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
  backfillStatus.done = true; // no startup backfill to wait on
  console.log(
    "[startup] lazy backfill mode — spaces will materialise on first request",
  );
} else {
  if (BACKFILL_MODE !== "eager") {
    console.warn(
      `[startup] unknown APPSERVER_BACKFILL_MODE "${BACKFILL_MODE}", defaulting to eager`,
    );
  }
  startupBackfill().catch((err) => {
    console.error("[startup] backfill failed:", err);
  });
}

async function startupBackfill(): Promise<void> {
  let client: RoomyServiceClient;
  try {
    client = await getServiceClient();
  } catch {
    console.warn(
      "[startup] Leaf not reachable yet; skipping startup backfill. " +
        "Spaces will be materialised lazily on first request.",
    );
    return;
  }

  const streams = await client.listStreams();
  const total = streams.length;
  backfillStatus.discovered = total;
  console.log(`[startup] discovered ${total} Leaf stream(s)`);

  if (total === 0) {
    backfillStatus.done = true;
    return;
  }

  // Materialise streams with bounded concurrency. Each worker pulls the next
  // stream off a shared index, so up to BACKFILL_CONCURRENCY spaces backfill at
  // once. This overlaps the per-stream Leaf subscription + profile fetches
  // (the dominant cost); SQLite writes still serialize on the single WAL
  // writer, so correctness is unaffected. The cap protects Leaf from a flood
  // of concurrent subscription requests.
  //
  // Circuit breaker: a per-worker consecutive-failure streak with exponential
  // backoff (see BACKFILL_FAILURE_THRESHOLD et al). When Leaf is unresponsive
  // every connect times out at 30s; without the breaker the worker would churn
  // through the whole queue at one 30s timeout per stream — hammering a wedged
  // Leaf and flooding logs (~3 lines per failure). With it, a failure streak
  // pauses the worker (5s→10s→…→60s cap) so pressure drops and logs quiet; a
  // single success resets the streak and full speed resumes. Failed streams
  // are skipped (relied on lazy materialisation on next request) so the queue
  // always drains and `done` fires.
  //
  // Per-DID start/complete logs are emitted at debug: with thousands of
  // streams they produce ~3N lines and were the primary trigger for platform
  // log-rate limits (Railway dropped ~16k messages in the incident that
  // motivated this). A batched progress summary at info (every
  // BACKFILL_PROGRESS_EVERY completions + the final line) preserves
  // observability. Set LOG_LEVEL=debug to see per-DID detail.
  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  const worker = async (): Promise<void> => {
    let consecutiveFailures = 0;
    let backoffStep = 0;
    while (true) {
      const i = backfillStatus.started++;
      if (i >= total) return;
      const s = streams[i]!; // i < total, guaranteed by the guard above

      log.debug(`[startup] backfilling ${s.did} (started ${i + 1}/${total})`);

      let mat: Awaited<ReturnType<typeof getOrCreateMaterializer>> | null = null;
      try {
        mat = await getOrCreateMaterializer(StreamDid.assert(s.did));
        // backfillDone is bounded by the SDK's backfill inactivity timeout
        // (LEAF_BACKFILL_INACTIVITY_TIMEOUT_MS, default 60s): a hung Leaf
        // subscription rejects instead of pending forever, so a worker can't
        // be stranded by one bad stream. See ConnectedSpace.doneBackfilling.
        await mat.backfillDone;
        // close() (drain + Leaf unsubscribe) is NOT bounded by the SDK, so race
        // it — a Leaf that dies right after backfill finished would otherwise
        // hang the worker in unsubscribe and stall the pipeline again.
        await withTimeout(mat.close(), CLOSE_TIMEOUT_MS, `close ${s.did}`);
        removeMaterializer(StreamDid.assert(s.did));
        backfillStatus.succeeded++;
        // Success: reset the circuit breaker so full-speed backfill resumes.
        consecutiveFailures = 0;
        backoffStep = 0;
        log.debug(
          `[startup] backfill complete for ${s.did}: ` +
            `applied=${mat.stats.applied} errors=${mat.stats.materializerErrors + mat.stats.applyErrors}`,
        );
      } catch (err) {
        backfillStatus.failed++;
        // Log the message only (1 line). Logging the raw Error renders a
        // multi-line source-frame snippet (~3 lines/failure) that, across a
        // failure flood, breaches platform log-rate limits. The full error
        // is still available at LOG_LEVEL=debug.
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[startup] backfill failed for ${s.did}: ${msg}`);
        log.debug(`[startup] backfill failed for ${s.did} (full):`, err);
        // Release the worker regardless. Drop the materializer from the
        // registry so a lazy retry builds a fresh one, and best-effort close
        // (raced — close isn't SDK-bounded) to tear down its Leaf subscription.
        // Without close, the abandoned subscription would keep applying live
        // events AND a lazy retry would open a second subscription for the
        // same stream (double materialisation). On timeout we give up on
        // cleanup and move on; the worker is unblocked either way.
        if (mat) {
          try {
            await withTimeout(mat.close(), CLOSE_TIMEOUT_MS, `close ${s.did}`);
          } catch {
            /* best-effort: a hung close must not re-stall the worker */
          }
        }
        removeMaterializer(StreamDid.assert(s.did));
        // Circuit breaker: on a failure streak, back off (exponential, capped)
        // before pulling the next stream. Stops a wedged Leaf from being
        // hammered by a 30s-timeout-per-stream churn and quiets the log flood.
        if (++consecutiveFailures >= BACKFILL_FAILURE_THRESHOLD) {
          const backoff = Math.min(
            BACKFILL_BACKOFF_MS * 2 ** backoffStep,
            BACKFILL_BACKOFF_MAX_MS,
          );
          log.warn(
            `[startup] backfill circuit breaker: ${consecutiveFailures} consecutive failures ` +
              `(Leaf may be unresponsive), pausing ${backoff}ms before next stream`,
          );
          await sleep(backoff);
          backoffStep++;
          consecutiveFailures = 0; // re-arm: need another THRESHOLD-failure streak.
          // NOTE: `backoffStep` is NOT reset here — it persists across re-armed
          // streaks, so a *prolonged* outage escalates the pause (5s→10s→20s→…)
          // even though each individual streak is only THRESHOLD failures. It
          // only resets on a successful backfill. Intentional: a long outage
          // should back off harder over time, not restart at 5s every 3 failures.
        }
      }

      backfillStatus.completed++;
      const completed = backfillStatus.completed;
      // Batched progress: every N completions, plus the final one. Avoids the
      // per-DID progress line that flooded logs at scale.
      if (completed === total || completed % BACKFILL_PROGRESS_EVERY === 0) {
        const remaining = total - completed;
        const pct = ((completed / total) * 100).toFixed(1);
        console.log(
          `[startup] progress ${completed}/${total} (${pct}% done, ${remaining} remaining)`,
        );
      }
    }
  };

  const workerCount = Math.min(BACKFILL_CONCURRENCY, total);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  backfillStatus.done = true;
  console.log(
    `[startup] backfill complete: ${backfillStatus.succeeded} succeeded, ${backfillStatus.failed} failed out of ${total} total`,
  );
}
