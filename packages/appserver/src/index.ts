import { XrpcRouter, prodAuthVerifier } from "./xrpc/index.ts";
import { Router as InvalidationRouter } from "./invalidation/index.ts";
import { setInvalidationRouter } from "./materialization/registry.ts";
import { openDb } from "./db/db.ts";
import { attachReadState, openReadStateDb } from "./db/readStateDb.ts";
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
import { updateSeenHandler } from "./handlers/space.roomy.room.updateSeen.ts";
import { sendEventsHandler } from "./handlers/space.roomy.space.sendEvents.ts";
import { createSpaceHandler } from "./handlers/space.roomy.space.createSpace.ts";
import { joinSpaceHandler } from "./handlers/space.roomy.space.joinSpace.ts";
import { leaveSpaceHandler } from "./handlers/space.roomy.space.leaveSpace.ts";
import { schemas } from "@roomy-space/sdk";

const PORT = Number(process.env.PORT ?? 8080);
const OWN_DID = process.env.APPSERVER_DID ?? "did:web:api.roomy.space";
const SERVICE_ENDPOINT =
  process.env.APPSERVER_ORIGIN ?? "https://api.roomy.space";

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

// ─── Invalidation + Sync ────────────────────────────────────────────────
// Singleton router — live events flow through every SpaceMaterializer
// created by the registry into this router, then out to the SyncManager
// which routes frames to WS connections.
const invalidationRouter = new InvalidationRouter();
InvalidationRouter.setInstance(invalidationRouter);
setInvalidationRouter(invalidationRouter);

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
