/**
 * Appserver factory — constructs a fully wired Bun.serve appserver instance
 * from options, decoupled from the process env and the boot path in
 * `index.ts`.
 *
 * Why: `index.ts` previously called `Bun.serve()` at module top-level with
 * hard-wired env reads, so importing it started the server and hit the
 * network. Extracting the construction here lets tests spin up a clean
 * appserver on an ephemeral port with a test auth verifier, a temp DB, and
 * backfill disabled — then `close()` it — without spawning a process.
 *
 * The boot path (`index.ts`) calls `createAppserver` with env-derived
 * options and then starts backfill; tests call it with `backfillMode:
 * "disabled"` and a `testAuthVerifier`.
 */

import type { Server } from "bun";
import { XrpcRouter, type AuthVerifier, type SyncHandler, type WsData } from "./xrpc/index.ts";
import { selectAuthVerifier } from "./xrpc/auth.ts";
import { appserverSigningKeyMultibase } from "./auth/serviceAuth.ts";
import { Router as InvalidationRouter } from "./invalidation/index.ts";
import { startEmbedSweeper, stopEmbedSweeper, embedSweeperStats } from "./embed/sweeper.ts";
import { countPendingLinks } from "./embed/enricher.ts";
import { openDb, openGlobalDb, openReadStateDb, openSpaceDb, openSpaceDbForEntity, closeDb, poolStats } from "./db/db.ts";
import { StreamManager, setStreamManager, _resetStreamManager } from "./streams/StreamManager.ts";
import { ACTIVE_WINDOW_MS, purgeStaleThreadActivity } from "./queries/userActiveThreads.ts";
import { getConnectionTicketHandler } from "./handlers/space.roomy.auth.getConnectionTicket.ts";
import { createSyncSubscribeHandler } from "./handlers/space.roomy.sync.subscribe.ts";
import { connectSpaceHandler } from "./handlers/space.roomy.admin.connectSpace.ts";
import { getEventsHandler } from "./handlers/space.roomy.sync.getEvents.ts";
import { materializeSpaceHandler } from "./handlers/space.roomy.admin.materializeSpace.ts";
import { getFlagsHandler } from "./handlers/space.roomy.getFlags.ts";
import { adminGetFlagsHandler } from "./handlers/space.roomy.admin.getFlags.ts";
import { adminSetFlagHandler } from "./handlers/space.roomy.admin.setFlag.ts";
import { adminClearFlagHandler } from "./handlers/space.roomy.admin.clearFlag.ts";
import { adminGetSubscriptionsHandler } from "./handlers/space.roomy.admin.push.getSubscriptions.ts";
import { adminGetPushStatsHandler } from "./handlers/space.roomy.admin.push.getStats.ts";
import { adminGetDashboardStatsHandler } from "./handlers/space.roomy.admin.getDashboardStats.ts";
import { adminListSpacesHandler } from "./handlers/space.roomy.admin.listSpaces.ts";
import { adminTestSendHandler } from "./handlers/space.roomy.admin.push.testSend.ts";
import { getSpacesHandler } from "./handlers/space.roomy.space.getSpaces.ts";
import { getMembersHandler } from "./handlers/space.roomy.space.getMembers.ts";
import { getMetadataHandler } from "./handlers/space.roomy.space.getMetadata.ts";
import { getSpaceSummaryHandler } from "./handlers/space.roomy.space.getSpaceSummary.ts";
import { getSpaceThreadsHandler } from "./handlers/space.roomy.space.getThreads.ts";
import { getRolesHandler } from "./handlers/space.roomy.space.getRoles.ts";
import { getInvitesHandler } from "./handlers/space.roomy.space.getInvites.ts";
import { getFederationRequestsHandler } from "./handlers/space.roomy.federation.getRequests.ts";
import { getFederationIncomingHandler } from "./handlers/space.roomy.federation.getIncoming.ts";
import { getFederationOutgoingHandler } from "./handlers/space.roomy.federation.getOutgoing.ts";
import { getFederationGrantsHandler } from "./handlers/space.roomy.federation.getGrants.ts";
import { getRoomMetadataHandler } from "./handlers/space.roomy.room.getMetadata.ts";
import { getRoomSummaryHandler } from "./handlers/space.roomy.room.getRoomSummary.ts";
import { getRoomThreadsHandler } from "./handlers/space.roomy.room.getThreads.ts";
import { getMessagesHandler } from "./handlers/space.roomy.room.getMessages.ts";
import { getMessageHandler } from "./handlers/space.roomy.message.getMessage.ts";
import { getReactionsHandler } from "./handlers/space.roomy.message.getReactions.ts";
import { getProfileHandler } from "./handlers/space.roomy.user.getProfile.ts";
import { getMentionsHandler } from "./handlers/space.roomy.mention.getMentions.ts";
import { searchMessagesHandler } from "./handlers/space.roomy.search.messages.ts";
import { searchRoomsHandler } from "./handlers/space.roomy.search.rooms.ts";
import { getLinkMetadataHandler } from "./handlers/space.roomy.embed.getLinkMetadata.ts";
import { updateSeenHandler } from "./handlers/space.roomy.room.updateSeen.ts";
import { sendEventsHandler } from "./handlers/space.roomy.space.sendEvents.ts";
import { createSpaceHandler } from "./handlers/space.roomy.space.createSpace.ts";
import { joinSpaceHandler } from "./handlers/space.roomy.space.joinSpace.ts";
import { leaveSpaceHandler } from "./handlers/space.roomy.space.leaveSpace.ts";
import { setHandleHandler } from "./handlers/space.roomy.space.setHandle.ts";
import { updatePolicyHandler } from "./handlers/space.roomy.space.updatePolicy.ts";
import { getActivityFeedHandler } from "./handlers/space.roomy.space.getActivityFeed.ts";
import { getUserAccessHandler } from "./handlers/space.roomy.space.getUserAccess.ts";
import { getVapidPublicKeyHandler } from "./handlers/space.roomy.push.getVapidPublicKey.ts";
import { getPreferencesHandler } from "./handlers/space.roomy.push.getPreferences.ts";
import { registerSubscriptionHandler } from "./handlers/space.roomy.push.registerSubscription.ts";
import { unregisterSubscriptionHandler } from "./handlers/space.roomy.push.unregisterSubscription.ts";
import { setPreferencesHandler } from "./handlers/space.roomy.push.setPreferences.ts";
import { startPushDispatcher, pushDispatcherStats, _resetPushDispatcher } from "./push/dispatcher.ts";
import { startSearchIndexer, stopSearchIndexer, searchIndexerStats } from "./search/indexer.ts";
import { startSearchBackfill, stopSearchBackfill, searchBackfillStats } from "./search/backfill.ts";
import { schemas } from "@roomy-space/sdk";
import { initHappyView, type HappyViewConfig } from "./happyview.ts";
import { initQdrant } from "./qdrant.ts";
import { getArbiterConfig, type ArbiterConfig } from "./arbiter/config.ts";
import type { GetProfilesFn } from "./materialization/profiles.ts";

import { proxyBlob } from "./blob.ts";
import { log } from "./log.ts";
import { metrics } from "./metrics.ts";
import { resolveBuildId } from "./telemetry/build.ts";
import {
  CACHEABLE_NSIDS,
  createQueryCacheFromEnv,
  attachCacheEvictionListener,
  type QueryCache,
} from "./cache/index.ts";

// ─── Options ──────────────────────────────────────────────────────────────


export interface AppserverOptions {
  /** Auth verifier. Defaults to `selectAuthVerifier()` (env-driven). */
  authVerifier?: AuthVerifier;
  /** Port to listen on. Defaults to `process.env.PORT` or 8080. */
  port?: number;
  /** Appserver DID (for JWT audience + did.json). Defaults to env or production. */
  ownDid?: string;
  /** Public origin (service endpoint in did.json). Defaults to env or production. */
  serviceEndpoint?: string;
  /** CORS origin header. Defaults to `process.env.CORS_ORIGIN` or `"*"`. */
  corsOrigin?: string;
  /** Materialisation DB path. Defaults to `dbPath("roomy-events.sqlite")` (under `DATA_DIR`). */
  dbPath?: string;
  /** Read-state DB path. Defaults to `dbPath("roomy-readstate.sqlite")` (under `DATA_DIR`). */
  readStateDbPath?: string;
  /** Suppress the per-request log.info lines. Tests set this to quiet output. */
  quiet?: boolean;
  /** Disable the background embed enrichment sweeper. Useful for tests that don't exercise embeds. */
  disableEmbedSweeper?: boolean;
  /** Disable ALL background worker loops: the embed enrichment sweeper, the
   *  search indexer + backfill sweeper, and the push dispatcher. E2E tests
   *  that exercise request handling directly set this: no detached loop is
   *  running against the test DB, so none can resume mid-teardown (a loop
   *  waking against a closed DB is the #1 CI flake source). Implies
   *  `disableEmbedSweeper`. */
  disableBackgroundWorkers?: boolean;
  /** Disable the query response cache. Tests set this so handler call counts
   *  are deterministic (the cache would skip the handler on the second call).
   *  Also disabled when the `APPSERVER_QUERY_CACHE_ENABLED` env var is `"false"`. */
  disableQueryCache?: boolean;
  /** HappyView profile index service config. When unset, reads from env
   *  (`HAPPYVIEW_ENDPOINT` / `HAPPYVIEW_DID`). When `null`, HappyView is
   *  disabled and profile fetching uses Bluesky only. */
  happyView?: HappyViewConfig | null;
  /** Custom profile fetcher for materialization. When set, replaces the
   *  HappyView-first / Bluesky fallback pipeline entirely. Tests pass a
   *  no-op stub to keep E2E runs hermetic (no api.bsky.app calls). */
  getProfiles?: GetProfilesFn;
  /** Arbiter server config. When unset, reads from env (`ARBITER_URL` /
   *  `ARBITER_DID`). When `null`, the arbiter is disabled and new spaces are
   *  self-provisioned (legacy did:plc path). */
  arbiter?: ArbiterConfig | null;
}



// ─── Result handle ────────────────────────────────────────────────────────

export interface AppserverHandle {
  /** The underlying Bun server. */
  server: Server<WsData>;
  /** The port the server is actually listening on. */
  port: number;
  /** The appserver DID. */
  ownDid: string;
  /** The query response cache, or undefined when caching is disabled. Exposed
   *  for stats/metrics and for tests to assert hit/miss behaviour. */
  queryCache: QueryCache | undefined;
  /** Stop the server, close DBs, and reset process-wide singletons. */
  close(): Promise<void>;
}

// ─── Route registration ───────────────────────────────────────────────────

/**
 * Build the XRPC router with all registered procedures/queries/sync.
 * The sync handler is injected so it shares the factory's invalidation
 * router. Extracted so it's reusable and testable without a running server.
 */
export function buildRouter(
  authVerifier: AuthVerifier,
  syncHandler: SyncHandler,
): XrpcRouter {
  return new XrpcRouter(authVerifier)
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
    .procedure("space.roomy.space.updatePolicy", {
      handler: updatePolicyHandler,
      inputSchema: schemas.procedures.updatePolicy.Input,
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
    // ── Feature flags ─────────────────────────────────────────────────────
    .query("space.roomy.getFlags", {
      handler: getFlagsHandler,
      paramsSchema: schemas.queries.getFlags.Params,
      outputSchema: schemas.queries.getFlags.Response,
    })
    // Admin flag endpoints (no arktype schemas — internal/admin, matching
    // the connectSpace/materializeSpace convention).
    .query("space.roomy.admin.getFlags", {
      handler: adminGetFlagsHandler,
    })
    .procedure("space.roomy.admin.setFlag", {
      handler: adminSetFlagHandler,
    })
    .procedure("space.roomy.admin.clearFlag", {
      handler: adminClearFlagHandler,
    })
    // Admin push diagnostics (no arktype schemas — internal/admin).
    .query("space.roomy.admin.push.getSubscriptions", {
      handler: adminGetSubscriptionsHandler,
    })
    .query("space.roomy.admin.push.getStats", {
      handler: adminGetPushStatsHandler,
    })
    .procedure("space.roomy.admin.push.testSend", {
      handler: adminTestSendHandler,
    })
    .query("space.roomy.admin.getDashboardStats", {
      handler: adminGetDashboardStatsHandler,
    })
    .query("space.roomy.admin.listSpaces", {
      handler: adminListSpacesHandler,
    })
    .query("space.roomy.sync.getEvents", {
      handler: getEventsHandler,
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
    .query("space.roomy.space.getSpaceSummary", {
      handler: getSpaceSummaryHandler,
      paramsSchema: schemas.queries.getSpaceSummary.Params,
      outputSchema: schemas.queries.getSpaceSummary.Response,
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
    .query("space.roomy.space.getUserAccess", {
      handler: getUserAccessHandler,
      paramsSchema: schemas.queries.getUserAccess.Params,
      outputSchema: schemas.queries.getUserAccess.Response,
    })
    .query("space.roomy.federation.getRequests", {
      handler: getFederationRequestsHandler,
      paramsSchema: schemas.queries.getFederationRequests.Params,
      outputSchema: schemas.queries.getFederationRequests.Response,
    })
    .query("space.roomy.federation.getIncoming", {
      handler: getFederationIncomingHandler,
      paramsSchema: schemas.queries.getFederationIncoming.Params,
      outputSchema: schemas.queries.getFederationIncoming.Response,
    })
    .query("space.roomy.federation.getOutgoing", {
      handler: getFederationOutgoingHandler,
      paramsSchema: schemas.queries.getFederationOutgoing.Params,
      outputSchema: schemas.queries.getFederationOutgoing.Response,
    })
    .query("space.roomy.federation.getGrants", {
      handler: getFederationGrantsHandler,
      paramsSchema: schemas.queries.getFederationGrants.Params,
      outputSchema: schemas.queries.getFederationGrants.Response,
    })
    .query("space.roomy.room.getMetadata", {
      handler: getRoomMetadataHandler,
      paramsSchema: schemas.queries.getRoomMetadata.Params,
      outputSchema: schemas.queries.getRoomMetadata.Response,
    })
    .query("space.roomy.room.getRoomSummary", {
      handler: getRoomSummaryHandler,
      paramsSchema: schemas.queries.getRoomSummary.Params,
      outputSchema: schemas.queries.getRoomSummary.Response,
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
    .query("space.roomy.user.getProfile", {
      handler: getProfileHandler,
      paramsSchema: schemas.queries.getProfile.Params,
      outputSchema: schemas.queries.getProfile.Response,
    })
    .query("space.roomy.mention.getMentions", {
      handler: getMentionsHandler,
      paramsSchema: schemas.queries.getMentions.Params,
      outputSchema: schemas.queries.getMentions.Response,
    })
    .query("space.roomy.search.messages", {
      handler: searchMessagesHandler,
      paramsSchema: schemas.queries.searchMessages.Params,
      outputSchema: schemas.queries.searchMessages.Response,
    })
    .query("space.roomy.search.rooms", {
      handler: searchRoomsHandler,
      paramsSchema: schemas.queries.searchRooms.Params,
      outputSchema: schemas.queries.searchRooms.Response,
    })
    .query("space.roomy.embed.getLinkMetadata", {
      handler: getLinkMetadataHandler,
      paramsSchema: schemas.queries.getLinkMetadata.Params,
      outputSchema: schemas.queries.getLinkMetadata.Response,
    })
    // ── Web push ──────────────────────────────────────────────────────────
    .query("space.roomy.push.getVapidPublicKey", {
      handler: getVapidPublicKeyHandler,
      paramsSchema: schemas.queries.getVapidPublicKey.Params,
      outputSchema: schemas.queries.getVapidPublicKey.Response,
    })
    .query("space.roomy.push.getPreferences", {
      handler: getPreferencesHandler,
      paramsSchema: schemas.queries.getPreferences.Params,
      outputSchema: schemas.queries.getPreferences.Response,
    })
    .procedure("space.roomy.push.registerSubscription", {
      handler: registerSubscriptionHandler,
      inputSchema: schemas.procedures.registerPushSubscription.Input,
    })
    .procedure("space.roomy.push.unregisterSubscription", {
      handler: unregisterSubscriptionHandler,
      inputSchema: schemas.procedures.unregisterPushSubscription.Input,
    })
    .procedure("space.roomy.push.setPreferences", {
      handler: setPreferencesHandler,
      inputSchema: schemas.procedures.setPreferences.Input,
    })
    .sync("space.roomy.sync.subscribe", {
      handler: syncHandler,
    });
}

/**
 * Return the list of registered XRPC NSIDs with their route kind.
 * Auto-discovers endpoints from buildRouter — new endpoints are measured
 * automatically by the perf harness.
 */
export function getRegisteredNsids(): { nsid: string; kind: string }[] {
  const router = buildRouter(
    // Dummy auth verifier — we only need the route registry, not actual auth.
    () => Promise.resolve({ did: null }),
    // Dummy sync handler — not used for NSID discovery.
    () => {},
  );
  return router.getRegisteredNsids();
}

// ─── Factory ──────────────────────────────────────────────────────────────

export async function createAppserver(
  opts: AppserverOptions = {},
): Promise<AppserverHandle> {
  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const ownDid = opts.ownDid ?? process.env.APPSERVER_DID ?? "did:web:api.roomy.space";
  const serviceEndpoint = opts.serviceEndpoint ?? process.env.APPSERVER_ORIGIN ?? "https://api.roomy.space";
  const corsOrigin = opts.corsOrigin ?? process.env.CORS_ORIGIN ?? "*";
  const quiet = opts.quiet ?? false;

  // ─── HappyView config ───────────────────────────────────────────────
  // Initialize the process-wide singleton. When `opts.happyView` is unset,
  // reads from env (`HAPPYVIEW_ENDPOINT` / `HAPPYVIEW_DID`). When `null`,
  // HappyView is explicitly disabled.
  const happyView = opts.happyView === undefined
    ? initHappyView()
    : (opts.happyView as HappyViewConfig | null);

  // ─── Qdrant config ──────────────────────────────────────────────────
  // Initialize the process-wide singleton from env (`QDRANT_URL` /
  // `QDRANT_API_KEY`). When unset, search is unavailable but the appserver
  // runs fine without it (the indexer queues nothing; the endpoint 503s).
  initQdrant();

  // ─── Arbiter config ────────────────────────────────────────────────
  // When `opts.arbiter` is unset, reads from env (`ARBITER_URL` /
  // `ARBITER_DID`). When `null`, the arbiter is disabled and new spaces are
  // self-provisioned (legacy did:plc path).
  const arbiter = opts.arbiter === undefined
    ? getArbiterConfig()
    : opts.arbiter;

  const DID_DOCUMENT = {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: ownDid,
    verificationMethod: [
      {
        id: `${ownDid}#atproto`,
        type: "Multikey",
        controller: ownDid,
        publicKeyMultibase: await appserverSigningKeyMultibase(),
      },
    ],
    service: [
      {
        id: "#space_roomy_appserver",
        type: "RoomyAppserver",
        serviceEndpoint,
      },
    ],
  };

  // ─── Databases ──────────────────────────────────────────────────────
  // Open as process-wide singletons so handlers' internal `openDb()` calls
  // resolve to the same handle. Tests that want isolation should reset the
  // singletons (closeDb) before calling createAppserver.
  //
  // `opts.dbPath` is honored here (event-log path; `:memory:` also pins the
  // read-state/global/spaces DBs to memory, see `openDb`). Previously the
  // option was dead: every factory test silently opened the real files under
  // `DATA_DIR`, and closeDb→reopen cycles raced SQLite file locks on shared
  // CI runners (surfacing as `database is locked` 500s).
  const mainDb = openDb(opts.dbPath !== undefined ? { path: opts.dbPath } : {});

  // ─── Periodic maintenance ────────────────────────────────────────────
  // Purge stale user_thread_activity rows older than the activity window
  // (120 hours) once per hour.
  const maintenanceTimer = setInterval(async () => {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    const purged = await purgeStaleThreadActivity(openReadStateDb(), cutoff);
    if (purged > 0) {
      log.info(`[maintenance] purged ${purged} stale user_thread_activity rows`);
    }
  }, 60 * 60 * 1000);
  maintenanceTimer.unref();

  // ─── Periodic metrics snapshot ──────────────────────────────────────
  // Emit a compact pool/cache/embed/search snapshot to Loki every 30s so
  // operators can chart saturation over time in Grafana without a metrics
  // backend. This is what surfaces a worker backlog (e.g. the system-worker
  // N+1) as a visible trend rather than a manual /health/pool curl.
  const metricsTimer = setInterval(() => {
    const pool = poolStats();
    const cache = queryCache?.stats ?? { hits: 0, misses: 0, evictions: 0, size: 0 };
    const embed = embedSweeperStats();
    const search = searchIndexerStats();
    const backfill = searchBackfillStats();
    log.info("[metrics] snapshot", {
      pool: pool
        ? {
            size: pool.size,
            spaceWorkers: pool.spaceWorkers.map((w) => w.pending),
            globalWorker: pool.globalWorker.pending,
            readStateWorker: pool.readStateWorker.pending,
            eventsWorker: pool.eventsWorker.pending,
          }
        : null,
      cache,
      embed: {
        pending: embed.priorityQueue ?? 0,
        inFlight: embed.inFlight ?? 0,
        enrichedNull: embed.enrichedNull ?? 0,
        dbBackoff: embed.dbBackoffActive ?? false,
      },
      search: {
        queue: search.queueLength ?? 0,
        backfilled: backfill.backfilled ?? 0,
      },
    });
  }, 30 * 1000);
  metricsTimer.unref();

  // ─── Invalidation + Sync ─────────────────────────────────────────────
  const invalidationRouter = new InvalidationRouter();
  InvalidationRouter.setInstance(invalidationRouter);

  // ─── StreamManager ────────────────────────────────────────────────────
  // Per-stream signing keys are generated on demand in createStreamDid.
  // No appserver-wide signing key is needed.
  const streamManager = new StreamManager(mainDb, {
    invalidationRouter,
    appserverUrl: serviceEndpoint,
    happyView,
    getProfiles: opts.getProfiles,
    arbiter,
    ownDid,
  });
  setStreamManager(streamManager);
  // Background worker loops (embed sweeper, search indexer/backfill, push
  // dispatcher). They are all safe to disable in tests: request handling is
  // independent, and a detached loop that resumes against a closed DB is a
  // teardown-race flake source (a loop's poke/backoff timer can fire after
  // closeDb(), turning a "Database is closed" rejection into an unhandled
  // error that fails the whole run).
  const backgroundWorkers = !opts.disableBackgroundWorkers;
  if (backgroundWorkers && !opts.disableEmbedSweeper) {
    // Start the centralized embed enrichment sweeper.
    startEmbedSweeper({ globalDb: openGlobalDb(), invalidationRouter });
  }
  if (backgroundWorkers) {
    // Start the Qdrant message-search indexer (drains the enqueue queue from
    // applyChunkSideEffects) and the boot backfill sweeper (re-indexes
    // messages missing from Qdrant). Both are no-op-safe when Qdrant is not
    // configured.
    startSearchIndexer();
    startSearchBackfill({ globalDb: openGlobalDb() });
  }
  if (backgroundWorkers) {
    // Start the centralized push dispatcher unconditionally. The dispatcher is
    // global infrastructure that processes every live createMessage and
    // computes fan-out. Starting it here means the StreamManager's pokes are
    // always queued and evaluated. No-op-safe when VAPID isn't configured
    // (deliveries just find no subscriptions).
    startPushDispatcher({ db: openReadStateDb() });
  }

  // ─── XRPC routes ──────────────────────────────────────────────────────
  const authVerifier = opts.authVerifier ?? selectAuthVerifier();
  const syncSubscribeHandler = createSyncSubscribeHandler(
    invalidationRouter,
    streamManager,
    {
      openSpaceDbForEntity,
      openSpaceDb,
    },
  );
  const router = buildRouter(authVerifier, syncSubscribeHandler);

  // ─── Query response cache ─────────────────────────────────────────────
  // Process-local LRU cache for hot, expensive queries whose responses are
  // fully covered by invalidation signals. Disabled via env kill switch.
  // Registered after InvalidationRouter.setInstance so the eviction listener
  // can subscribe to the singleton.
  const queryCache = opts.disableQueryCache ? undefined : createQueryCacheFromEnv();
  let cacheUnsub: (() => void) | undefined;
  if (queryCache) {
    router.setQueryCache(queryCache, CACHEABLE_NSIDS);
    cacheUnsub = attachCacheEvictionListener(invalidationRouter, queryCache);
  }

  // ─── Server ─────────────────────────────────────────────────────────
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Atproto-Proxy, X-Test-Did",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  // ─── Request metrics ────────────────────────────────────────────────
  // Per-endpoint request counter + latency histogram. The /metrics endpoint
  // (Prometheus scrape) exposes these so a dashboard can show which XRPC
  // endpoint is slow and how often it's called — the first signal that
  // pinpoints a pool-saturation / N+1 bottleneck.
  const xrpcRequests = metrics.counter(
    "roomy_xrpc_requests_total",
    "Total XRPC/HTTP requests handled, by endpoint, method and status.",
    ["endpoint", "method", "status"],
  );
  const xrpcDuration = metrics.histogram(
    "roomy_xrpc_request_duration_seconds",
    "Request handling latency in seconds, by endpoint and method.",
    ["endpoint", "method"],
  );

  // Live gauges refreshed on each /metrics scrape from the health stats.
  const poolGauge = metrics.gauge("roomy_pool_size", "Number of per-space DB workers in the pool.");
  const poolWorkerPending = metrics.gauge(
    "roomy_pool_worker_pending",
    "In-flight (queued) requests on a pool worker.",
    ["worker"],
  );
  const cacheHits = metrics.gauge("roomy_cache_hits_total", "Query response cache hits.");
  const cacheMisses = metrics.gauge("roomy_cache_misses_total", "Query response cache misses.");
  const cacheEvictions = metrics.gauge("roomy_cache_evictions_total", "Query response cache evictions.");
  const cacheSize = metrics.gauge("roomy_cache_size", "Query response cache entries.");
  const embedPending = metrics.gauge("roomy_embed_pending", "Embed links awaiting enrichment.");
  const embedInFlight = metrics.gauge("roomy_embed_in_flight", "Embed enrichments currently in flight.");
  const embedEnrichedNull = metrics.gauge("roomy_embed_enriched_null", "Embed links enriched to null (no card).");
  const embedDbBackoff = metrics.gauge("roomy_embed_db_backoff", "1 when the embed sweeper is in DB backoff.");
  const searchQueue = metrics.gauge("roomy_search_indexer_queue", "Search indexer queue length.");
  const searchBackfilled = metrics.gauge("roomy_search_backfilled", "Search backfill progress.");
  const pushQueued = metrics.gauge("roomy_push_queued", "Push dispatcher queued messages.");

  const server = Bun.serve({
    port,
    idleTimeout: 255,
    fetch: async (req, server) => {
      try {
        return await handleFetch(req, server);
      } catch (err) {
        // During teardown (tests) the DB workers are terminated while
        // requests are in flight; the rejection is expected and must not
        // surface as an unhandled error (bun exits 1 on those). The server
        // is being stopped anyway.
        if (!quiet) log.info(`${req.method} ${new URL(req.url).pathname} → error during teardown: ${err instanceof Error ? err.message : String(err)}`);
        return new Response("Service shutting down", { status: 503 });
      }
    },
    websocket: router.websocket,
  });

  async function handleFetchInner(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(req.url);

      if (url.pathname === "/.well-known/did.json") {
        return new Response(JSON.stringify(DID_DOCUMENT), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }

      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            status: "ok",
            uptime: process.uptime(),
            did: ownDid,
            port,
            build_id: resolveBuildId(),
          }),
          { headers: { "content-type": "application/json", ...corsHeaders } },
        );
      }
      if (url.pathname === "/health/embed") {
        const stats = embedSweeperStats();
        let pending: number;
        try {
          pending = await countPendingLinks(openGlobalDb());
        } catch {
          pending = -1;
        }
        return new Response(
          JSON.stringify({ ...stats, pending }),
          { headers: { "content-type": "application/json", ...corsHeaders } },
        );
      }
      if (url.pathname === "/health/push") {
        return new Response(JSON.stringify(pushDispatcherStats()), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
      if (url.pathname === "/health/search") {
        return new Response(
          JSON.stringify({
            indexer: searchIndexerStats(),
            backfill: searchBackfillStats(),
          }),
          { headers: { "content-type": "application/json", ...corsHeaders } },
        );
      }
      if (url.pathname === "/health/cache") {
        const cacheStats = queryCache?.stats ?? {
          hits: 0,
          misses: 0,
          evictions: 0,
          size: 0,
        };
        return new Response(
          JSON.stringify({
            enabled: queryCache !== undefined,
            ...cacheStats,
          }),
          { headers: { "content-type": "application/json", ...corsHeaders } },
        );
      }
      if (url.pathname === "/health/pool") {
        // Per-worker pool stats (size + in-flight per worker) so an operator
        // can see whether load is spreading across the pool and the three
        // shared-DB workers, or collapsing onto one.
        const stats = poolStats();
        return new Response(
          JSON.stringify(stats ? { enabled: true, ...stats } : { enabled: false }),
          { headers: { "content-type": "application/json", ...corsHeaders } },
        );
      }

      if (url.pathname === "/metrics") {
        // Prometheus text exposition for the observability stack (Alloy
        // scrapes this and remote-writes to Grafana Cloud Mimir). Pulls the
        // live pool/cache/embed/search/push stats into gauges, then renders
        // the registry (request counters/histograms + DB timeouts are
        // maintained incrementally elsewhere).
        const pool = poolStats();
        if (pool) {
          poolGauge.set({}, pool.size);
          pool.spaceWorkers.forEach((w, i) => poolWorkerPending.set({ worker: `space-${i}` }, w.pending));
          poolWorkerPending.set({ worker: "global" }, pool.globalWorker.pending);
          poolWorkerPending.set({ worker: "readstate" }, pool.readStateWorker.pending);
          poolWorkerPending.set({ worker: "events" }, pool.eventsWorker.pending);
        }
        const cache = queryCache?.stats ?? { hits: 0, misses: 0, evictions: 0, size: 0 };
        cacheHits.set({}, cache.hits);
        cacheMisses.set({}, cache.misses);
        cacheEvictions.set({}, cache.evictions);
        cacheSize.set({}, cache.size);
        const embed = embedSweeperStats();
        embedPending.set({}, embed.priorityQueue ?? 0);
        embedInFlight.set({}, embed.inFlight ?? 0);
        embedEnrichedNull.set({}, embed.enrichedNull ?? 0);
        embedDbBackoff.set({}, embed.dbBackoffActive ? 1 : 0);
        const search = searchIndexerStats();
        searchQueue.set({}, search.queueLength ?? 0);
        const backfill = searchBackfillStats();
        searchBackfilled.set({}, backfill.backfilled ?? 0);
        const push = pushDispatcherStats();
        pushQueued.set({}, push.queueDepth ?? 0);
        return new Response(metrics.render(), {
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", ...corsHeaders },
        });
      }

      const blobMatch = url.pathname.match(/^\/blob\/(.+?)\/(.+)$/);
      if (blobMatch && req.method === "GET") {
        const did = decodeURIComponent(blobMatch[1]!);
        const cid = decodeURIComponent(blobMatch[2]!);
        const res = await proxyBlob(did, cid, req);
        for (const [k, v] of Object.entries(corsHeaders)) {
          res.headers.set(k, v);
        }
        return res;
      }

      const res = await router.fetch(req, server);
      if (res === undefined) {
        return undefined;
      }
      for (const [k, v] of Object.entries(corsHeaders)) {
        res.headers.set(k, v);
      }
      return res;
  }

  // Wrapper that records per-request metrics (counter + latency histogram)
  // and adds a duration field to the access log. The inner function has many
  // early returns (health endpoints, blob proxy, ws upgrade), so measuring
  // here keeps the instrumentation in one place.
  async function handleFetch(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    const start = performance.now();
    const pathname = new URL(req.url).pathname;
    try {
      const res = await handleFetchInner(req, server);
      const status = res?.status ?? 0; // 0 = ws upgrade (undefined response)
      const durationMs = performance.now() - start;
      xrpcRequests.inc({ endpoint: pathname, method: req.method, status: String(status) });
      xrpcDuration.observe({ endpoint: pathname, method: req.method }, durationMs / 1000);
      if (!quiet && res) {
        log.info(`[xrpc] ${req.method} ${pathname} → ${res.status}`, { duration_ms: Math.round(durationMs) });
      }
      return res;
    } catch (err) {
      const durationMs = performance.now() - start;
      xrpcRequests.inc({ endpoint: pathname, method: req.method, status: "500" });
      xrpcDuration.observe({ endpoint: pathname, method: req.method }, durationMs / 1000);
      throw err;
    }
  }

  if (!quiet) log.info(`Appserver listening on port ${port} (DID: ${ownDid})`);

  return {
    server,
    port: server.port ?? port,
    ownDid,
    queryCache,
    close(): Promise<void> {
      return stopEmbedSweeper()
        .then(() => stopSearchIndexer())
        .then(() => stopSearchBackfill())
        .finally(() => {
        // Graceful stop: wait for in-flight requests to complete so their
        // DB awaits resolve (or reject into the fetch guard's catch) before
        // the workers are terminated. A forced stop kills the handlers
        // mid-await, leaving their rejections unhandled (bun exits 1).
        try {
          server.stop();
        } catch (e) {
          log.error("appserver close: server.stop failed", e);
        }
        try {
          clearInterval(maintenanceTimer);
          clearInterval(metricsTimer);
          closeDb();
        } catch (e) {
          log.error("appserver close: closeDb failed", e);
        }
        try {
          _resetStreamManager();
        } catch (e) {
          log.error("appserver close: _resetStreamManager failed", e);
        }
        try {
          _resetPushDispatcher();
        } catch (e) {
          log.error("appserver close: _resetPushDispatcher failed", e);
        }
        try {
          if (cacheUnsub) cacheUnsub();
          if (queryCache) queryCache.clear();
        } catch (e) {
          log.error("appserver close: query cache cleanup failed", e);
        }
        try {
          InvalidationRouter.resetInstance();
        } catch (e) {
          log.error("appserver close: resetInvalidationRouter failed", e);
        }
      });
    },
  };
}