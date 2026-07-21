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
import { Router as InvalidationRouter } from "./invalidation/index.ts";
import { startEmbedSweeper, stopEmbedSweeper, embedSweeperStats } from "./embed/sweeper.ts";
import { countPendingLinks } from "./embed/enricher.ts";
import { openDb, closeDb } from "./db/db.ts";
import { StreamManager, setStreamManager, _resetStreamManager } from "./streams/StreamManager.ts";
import { purgeStaleThreadActivity } from "./queries/userActiveThreads.ts";
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
import { adminTestSendHandler } from "./handlers/space.roomy.admin.push.testSend.ts";
import { getSpacesHandler } from "./handlers/space.roomy.space.getSpaces.ts";
import { getMembersHandler } from "./handlers/space.roomy.space.getMembers.ts";
import { getMetadataHandler } from "./handlers/space.roomy.space.getMetadata.ts";
import { getSpaceSummaryHandler } from "./handlers/space.roomy.space.getSpaceSummary.ts";
import { getSpaceThreadsHandler } from "./handlers/space.roomy.space.getThreads.ts";
import { getRolesHandler } from "./handlers/space.roomy.space.getRoles.ts";
import { getInvitesHandler } from "./handlers/space.roomy.space.getInvites.ts";
import { getRoomMetadataHandler } from "./handlers/space.roomy.room.getMetadata.ts";
import { getRoomSummaryHandler } from "./handlers/space.roomy.room.getRoomSummary.ts";
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
import { getVapidPublicKeyHandler } from "./handlers/space.roomy.push.getVapidPublicKey.ts";
import { getPreferencesHandler } from "./handlers/space.roomy.push.getPreferences.ts";
import { registerSubscriptionHandler } from "./handlers/space.roomy.push.registerSubscription.ts";
import { unregisterSubscriptionHandler } from "./handlers/space.roomy.push.unregisterSubscription.ts";
import { setPreferencesHandler } from "./handlers/space.roomy.push.setPreferences.ts";
import { startPushDispatcher, pushDispatcherStats, _resetPushDispatcher } from "./push/dispatcher.ts";
import { schemas } from "@roomy-space/sdk";
import { proxyBlob } from "./blob.ts";

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
  /** Materialisation DB path. Defaults to `process.env.APPSERVER_DB_PATH`. */
  dbPath?: string;
  /** Read-state DB path. Defaults to `process.env.READSTATE_DB_PATH`. */
  readStateDbPath?: string;
  /** Suppress the per-request console.log. Tests set this to quiet output. */
  quiet?: boolean;
  /** Disable the background embed enrichment sweeper. Useful for tests that don't exercise embeds. */
  disableEmbedSweeper?: boolean;
}



// ─── Result handle ────────────────────────────────────────────────────────

export interface AppserverHandle {
  /** The underlying Bun server. */
  server: Server<WsData>;
  /** The port the server is actually listening on. */
  port: number;
  /** The appserver DID. */
  ownDid: string;
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


  const DID_DOCUMENT = {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: ownDid,
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
  const mainDb = openDb();

  // ─── Periodic maintenance ────────────────────────────────────────────
  // Purge stale user_thread_activity rows older than 72 hours once per hour.
  const maintenanceTimer = setInterval(async () => {
    const cutoff = Date.now() - 72 * 60 * 60 * 1000;
    const purged = await purgeStaleThreadActivity(mainDb, cutoff);
    if (purged > 0) {
      console.log(`[maintenance] purged ${purged} stale user_thread_activity rows`);
    }
  }, 60 * 60 * 1000);
  maintenanceTimer.unref();

  // ─── Invalidation + Sync ─────────────────────────────────────────────
  const invalidationRouter = new InvalidationRouter();
  InvalidationRouter.setInstance(invalidationRouter);

  // ─── StreamManager ────────────────────────────────────────────────────
  // Per-stream signing keys are generated on demand in createStreamDid.
  // No appserver-wide signing key is needed.
  const streamManager = new StreamManager(mainDb, {
    invalidationRouter,
    appserverUrl: serviceEndpoint,
  });
  setStreamManager(streamManager);
  // Start the centralized embed enrichment sweeper.
  startEmbedSweeper({ db: mainDb, invalidationRouter });
  // Start the centralized push dispatcher unconditionally. The dispatcher is
  // global infrastructure that processes every live createMessage and
  // computes fan-out; the `push-notifications` feature flag is a per-recipient
  // filter applied during evaluation (see push/evaluate.ts), not a process-
  // level kill switch. Starting it here means the StreamManager's pokes are
  // always queued and evaluated regardless of flag state. No-op-safe when
  // VAPID isn't configured (deliveries just find no subscriptions).
  startPushDispatcher({ db: mainDb });

  // ─── XRPC routes ──────────────────────────────────────────────────────
  const authVerifier = opts.authVerifier ?? selectAuthVerifier();
  const syncSubscribeHandler = createSyncSubscribeHandler(invalidationRouter, streamManager);
  const router = buildRouter(authVerifier, syncSubscribeHandler);

  // ─── Server ─────────────────────────────────────────────────────────
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Atproto-Proxy, X-Test-Did",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  const server = Bun.serve({
    port,
    idleTimeout: 255,
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

      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            status: "ok",
            uptime: process.uptime(),
            did: ownDid,
            port,
          }),
          { headers: { "content-type": "application/json", ...corsHeaders } },
        );
      }
      if (url.pathname === "/health/embed") {
        const stats = embedSweeperStats();
        let pending: number;
        try {
          pending = await countPendingLinks(mainDb);
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

      const blobMatch = url.pathname.match(/^\/blob\/(.+?)\/(.+)$/);
      if (blobMatch && req.method === "GET") {
        const did = decodeURIComponent(blobMatch[1]!);
        const cid = decodeURIComponent(blobMatch[2]!);
        const res = await proxyBlob(did, cid, req);
        if (!quiet) console.log(`${req.method} ${url.pathname} → ${res.status}`);
        for (const [k, v] of Object.entries(corsHeaders)) {
          res.headers.set(k, v);
        }
        return res;
      }

      const res = await router.fetch(req, server);
      if (res === undefined) {
        if (!quiet) console.log(`${req.method} ${url.pathname} → [ws upgrade]`);
        return undefined;
      }
      if (!quiet) console.log(`${req.method} ${url.pathname} → ${res.status}`);
      for (const [k, v] of Object.entries(corsHeaders)) {
        res.headers.set(k, v);
      }
      return res;
    },
    websocket: router.websocket,
  });

  if (!quiet) console.log(`Appserver listening on port ${port} (DID: ${ownDid})`);

  return {
    server,
    port: server.port ?? port,
    ownDid,
    close(): Promise<void> {
      return stopEmbedSweeper().finally(() => {
        try {
          server.stop(true);
        } catch (e) {
          console.error("appserver close: server.stop failed", e);
        }
        try {
          clearInterval(maintenanceTimer);
          closeDb();
        } catch (e) {
          console.error("appserver close: closeDb failed", e);
        }
        try {
          _resetStreamManager();
        } catch (e) {
          console.error("appserver close: _resetStreamManager failed", e);
        }
        try {
          _resetPushDispatcher();
        } catch (e) {
          console.error("appserver close: _resetPushDispatcher failed", e);
        }
        try {
          InvalidationRouter.resetInstance();
        } catch (e) {
          console.error("appserver close: resetInvalidationRouter failed", e);
        }
      });
    },
  };
}