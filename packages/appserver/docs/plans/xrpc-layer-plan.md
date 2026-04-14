# Custom XRPC Layer on Bun Native — Implementation Plan

**Date:** 2026-04-13
**Status:** Updated for multiplexed WS design
**Parent doc:** `appserver-architecture.md`
**Interface spec:** `xrpc-interface-spec.md`

## Decision

Build a custom XRPC routing layer using Bun's native HTTP + WebSocket server (`Bun.serve()`). Do **not** use `@atproto/xrpc-server` or Express. Do **not** use the `ws` npm package.

**Rationale:**
- `@atproto/xrpc-server` is tightly coupled to Express 4.x and `ws` (hard deps, not peer deps)
- The multiplexed sync protocol is not a standard ATProto subscription — it requires bidirectional messaging (sub/unsub/cursor from client)
- Bun native WebSocket supports bidirectional messaging natively
- Auth-before-upgrade pattern maps cleanly onto Bun's `server.upgrade(req, { data })` mechanism
- This is a transitional service — minimising dependencies is correct

**CBOR library:** Use `@atcute/cbor` (already used by `@roomy-space/sdk`). Do **not** add `cbor-x`.

**Key change from original plan:** Instead of per-procedure `AsyncIterable<Frame>` subscriptions, there is a single multiplexed `space.roomy.sync.subscribe` handler that manages topic subscriptions and routes frames based on Leaf events.

---

## File Structure

```
packages/appserver/src/
  index.ts                              ← Bun.serve() entry point; wires router + all handlers
  xrpc/
    index.ts                            ← barrel re-export
    types.ts                            ← all shared TypeScript types
    router.ts                           ← XrpcRouter class: register + route + WS lifecycle
    frame.ts                            ← Frame type + CBOR encoding helpers
    auth.ts                             ← AuthVerifier type + JWT validation + ticket store
    errors.ts                           ← XrpcError class + toErrorResponse()
  sync/
    handler.ts                          ← SyncHandler: manages per-connection topic subscriptions
    topics.ts                           ← Topic matching: Leaf event → affected topics → frames
  handlers/
    space.getSpaces.ts
    space.getMetadata.ts                ← includes sidebar tree
    space.getThreads.ts
    room.getMetadata.ts                 ← includes recent threads
    room.getMessages.ts
    room.getThreads.ts
    message.getMessage.ts
    message.getMessage.ts
    auth.getConnectionTicket.ts         ← Already exists
```

XRPC layer: ~350 lines. Sync handler: ~200 lines. Each query handler: ~20–80 lines.

---

## Type Definitions (`xrpc/types.ts`)

```typescript
export interface AuthCtx {
  did: string;
}

// ATProto wire format: header + body, both CBOR-encoded, concatenated into one binary WS message
export interface Frame {
  header: FrameHeader;
  body: Record<string, unknown>;
}

export interface FrameHeader {
  op: 1 | -1;  // 1 = message, -1 = error
  t: string;   // event type: "#messageDiff", "#invalidate", "#error"
}

export type QueryParams = Record<string, string | string[] | undefined>;

// Query handler: receives params + auth, returns JSON-serialisable result
export type QueryHandler<
  TParams extends QueryParams = QueryParams,
  TResult = unknown,
> = (params: TParams, auth: AuthCtx) => Promise<TResult>;

// Procedure handler: same shape as query but uses POST
export type ProcedureHandler<
  TParams extends QueryParams = QueryParams,
  TResult = unknown,
> = (params: TParams, auth: AuthCtx) => Promise<TResult>;

// Sync handler: called once when the multiplexed WS opens. Manages topic subscriptions.
// Receives a SyncSocket abstraction — never touches raw Bun WebSocket directly.
export type SyncHandler = (socket: SyncSocket, auth: AuthCtx) => void;

export interface SyncSocket {
  // Send a CBOR frame to the client
  send(frame: Frame): void;
  // Register handler for incoming client messages (sub/unsub/cursor)
  onMessage(handler: (msg: ClientMessage) => void): void;
  // Register handler for when the connection closes
  onClose(handler: () => void): void;
  // Check if connection is still open
  readonly isOpen: boolean;
}

// Client → Server message types (JSON text frames)
export type ClientMessage =
  | { type: "sub"; topic: "space" | "room" | "page"; id: string }
  | { type: "unsub"; topic: "space" | "room" | "page"; id: string }
  | { type: "cursor"; seq: number };

export interface QueryDef {
  kind: "query";
  handler: QueryHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
}

export interface ProcedureDef {
  kind: "procedure";
  handler: ProcedureHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
}

export interface SyncDef {
  kind: "sync";
  handler: SyncHandler;
}

export type RouteDef = QueryDef | ProcedureDef | SyncDef;
```

Key changes from original:
- Removed `SubscriptionDef` (per-procedure `AsyncIterable<Frame>`) — replaced with `SyncDef`
- Added `ClientMessage` type for bidirectional WS communication
- Added `SyncSocket` abstraction to decouple sync handler from Bun WebSocket API
- Added `ProcedureDef` for POST endpoints (ticket issuance)

---

## Frame Encoding (`xrpc/frame.ts`)

Unchanged from original. ATProto wire format: two consecutive CBOR values in one binary message.

```typescript
import { encode } from "@atcute/cbor";
import type { Frame } from "./types.ts";

export function encodeFrame(frame: Frame): Uint8Array {
  const headerBytes = encode(frame.header);
  const bodyBytes = encode(frame.body);
  const out = new Uint8Array(headerBytes.byteLength + bodyBytes.byteLength);
  out.set(headerBytes, 0);
  out.set(bodyBytes, headerBytes.byteLength);
  return out;
}

export function messageFrame(eventType: string, body: Record<string, unknown>): Frame {
  return { header: { op: 1, t: eventType }, body };
}

export function errorFrame(error: string, message: string): Frame {
  return { header: { op: -1, t: "#error" }, body: { error, message } };
}
```

---

## Router (`xrpc/router.ts`)

The `XrpcRouter` exposes `.fetch` and `.websocket` for `Bun.serve()`. Three registration methods:

- `.query(nsid, def)` — HTTP GET endpoints
- `.procedure(nsid, def)` — HTTP POST endpoints
- `.sync(nsid, def)` — the single multiplexed WebSocket subscription

```typescript
import type { Server } from "bun";
import type { AuthCtx, QueryParams, RouteDef, ClientMessage, SyncSocket } from "./types.ts";
import type { AuthVerifier } from "./auth.ts";
import { consumeTicket } from "./auth.ts";
import { encodeFrame, errorFrame } from "./frame.ts";
import { XrpcError, toErrorResponse } from "./errors.ts";

interface WsData {
  auth: AuthCtx;
  abort: AbortController;
  onMessage?: (msg: ClientMessage) => void;
  onClose?: () => void;
}

export class XrpcRouter {
  readonly #routes = new Map<string, RouteDef>();
  readonly #auth: AuthVerifier;

  constructor(auth: AuthVerifier) {
    this.#auth = auth;
  }

  query(nsid: string, def: Omit<import("./types.ts").QueryDef, "kind">): this {
    this.#routes.set(nsid, { kind: "query", ...def });
    return this;
  }

  procedure(nsid: string, def: Omit<import("./types.ts").ProcedureDef, "kind">): this {
    this.#routes.set(nsid, { kind: "procedure", ...def });
    return this;
  }

  sync(nsid: string, def: Omit<import("./types.ts").SyncDef, "kind">): this {
    this.#routes.set(nsid, { kind: "sync", ...def });
    return this;
  }

  get fetch(): (req: Request, server: Server<WsData>) => Promise<Response | undefined> {
    return async (req, server) => {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/xrpc\/(.+)$/);
      if (!match?.[1]) return new Response("Not found", { status: 404 });
      const nsid = match[1];

      const route = this.#routes.get(nsid);
      if (!route) {
        return Response.json(
          { error: "MethodNotFound", message: `Unknown NSID: ${nsid}` },
          { status: 404 },
        );
      }

      const rawParams: QueryParams = {};
      for (const [k, v] of url.searchParams.entries()) {
        const existing = rawParams[k];
        if (existing !== undefined) {
          rawParams[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
        } else {
          rawParams[k] = v;
        }
      }

      try {
        // HTTP queries (GET)
        if (route.kind === "query") {
          const auth = await this.#auth(req);
          const params = route.parseParams ? route.parseParams(rawParams) : rawParams;
          const result = await route.handler(params, auth);
          return Response.json(result);
        }

        // HTTP procedures (POST)
        if (route.kind === "procedure") {
          const auth = await this.#auth(req);
          const params = route.parseParams ? route.parseParams(rawParams) : rawParams;
          const result = await route.handler(params, auth);
          return Response.json(result);
        }

        // Multiplexed sync WebSocket
        if (route.kind === "sync") {
          const ticket = rawParams["ticket"];
          if (typeof ticket !== "string" || ticket === "") {
            return Response.json(
              { error: "AuthRequired", message: "ticket query parameter required" },
              { status: 401 },
            );
          }
          const did = consumeTicket(ticket);
          const auth: AuthCtx = { did };

          const abort = new AbortController();
          const upgraded = server.upgrade(req, {
            data: { auth, abort } satisfies WsData,
          });
          if (!upgraded) return new Response("Expected WebSocket upgrade", { status: 426 });
          return undefined;
        }
      } catch (err) {
        return toErrorResponse(err);
      }
    };
  }

  get websocket(): import("bun").WebSocketHandler<WsData> {
    return {
      open: (ws) => {
        const { auth, abort } = ws.data;

        // Find the sync route (there should be exactly one)
        for (const [nsid, route] of this.#routes) {
          if (route.kind !== "sync") continue;

          const socket: SyncSocket = {
            send: (frame) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(encodeFrame(frame));
              }
            },
            onMessage: (handler) => {
              ws.data.onMessage = handler;
            },
            onClose: (handler) => {
              ws.data.onClose = handler;
            },
            get isOpen() {
              return ws.readyState === WebSocket.OPEN;
            },
          };

          route.handler(socket, auth);
          break;
        }
      },

      message: (ws, msg) => {
        // Client → Server: JSON text messages (sub/unsub/cursor)
        if (typeof msg !== "string") return;
        try {
          const parsed = JSON.parse(msg) as ClientMessage;
          ws.data.onMessage?.(parsed);
        } catch {
          // Malformed client message — ignore
        }
      },

      close: (ws) => {
        ws.data.abort.abort();
        ws.data.onClose?.();
      },
    };
  }
}
```

Key changes from original:
- `.subscription()` replaced with `.sync()` — takes a `SyncHandler`, not an `AsyncIterable<Frame>`
- `websocket.open` creates a `SyncSocket` wrapper and calls the sync handler
- `websocket.message` parses JSON client messages and forwards to handler via callback
- No more per-connection `AsyncIterable` loop — the sync handler is imperative
- WsData stores `onMessage`/`onClose` callbacks instead of `nsid`/`params`

---

## Sync Handler (`sync/handler.ts`)

The sync handler manages per-connection topic subscriptions and routes Leaf events to the appropriate WebSocket frames.

```typescript
import type { SyncSocket, ClientMessage } from "../xrpc/types.ts";
import { messageFrame } from "../xrpc/frame.ts";
import { topicMatcher } from "./topics.ts";

export function createSyncHandler(
  leafSubscription: LeafEventSource,
) {
  return (socket: SyncSocket, _auth: import("../xrpc/types.ts").AuthCtx) => {
    const subscriptions = new Map<string, Set<string>>();
    // topic → Set of subscription IDs (for cleanup)
    // e.g. "room:abc123" → Set { "room:abc123" }

    let lastSeq = 0;

    // Handle incoming client messages
    socket.onMessage((msg: ClientMessage) => {
      if (msg.type === "sub") {
        const topicKey = `${msg.topic}:${msg.id}`;
        subscriptions.set(topicKey, new Set([topicKey]));
      } else if (msg.type === "unsub") {
        const topicKey = `${msg.topic}:${msg.id}`;
        subscriptions.delete(topicKey);
      } else if (msg.type === "cursor") {
        // Replay missed events from SQLite since seq
        // Then send invalidation signals for all subscribed topics
        replayFromCursor(socket, msg.seq, subscriptions);
        lastSeq = msg.seq;
      }
    });

    // Listen for Leaf events and route to this connection if subscribed
    const unsubscribe = leafSubscription.onEvent((event) => {
      const matchingTopics = topicMatcher.getMatchingTopics(event);
      for (const topic of matchingTopics) {
        if (!subscriptions.has(topic)) continue;

        const frames = topicMatcher.eventToFrames(event, topic);
        for (const frame of frames) {
          if (!socket.isOpen) break;
          socket.send(frame);
        }
      }
      lastSeq = event.seq;
    });

    // Clean up on disconnect
    socket.onClose(() => {
      unsubscribe();
      subscriptions.clear();
    });
  };
}
```

---

## Topic Matching (`sync/topics.ts`)

Maps Leaf events to affected topics and generates the appropriate frames.

```typescript
import type { Frame } from "../xrpc/types.ts";
import { messageFrame } from "../xrpc/frame.ts";

// Leaf event → set of affected topic strings
// e.g. a message in room "abc" → ["room:abc"]
// e.g. a sidebar change in space "xyz" → ["space:xyz"]
export function getMatchingTopics(event: LeafEvent): string[] {
  switch (event.type) {
    case "createMessage":
    case "editMessage":
    case "deleteMessage":
    case "addBridgedReaction":
    case "removeBridgedReaction":
      return [`room:${event.roomId}`];

    case "updateSidebar":
    case "createRoom":
    case "updateProfile":  // space-level profile change
      return [`space:${event.spaceId}`];

    case "createRoomLink":
    case "deleteRoomLink":
      return [`room:${event.roomId}`, `space:${event.spaceId}`];

    case "editPage":
      return [`page:${event.pageId}`];

    // NOTE: membership events (join/leave) are not handled yet.
    // When membership tracking is implemented, add cases here to
    // route them to the appropriate topic (e.g. `room:${event.roomId}`
    // or `space:${event.spaceId}`).

    default:
      return [];
  }
}

// Leaf event + topic → array of frames to send
export function eventToFrames(event: LeafEvent, topic: string): Frame[] {
  if (topic.startsWith("room:")) {
    // Message events → #messageDiff
    if (event.type === "createMessage" || event.type === "editMessage" ||
        event.type === "deleteMessage" ||
        event.type === "addBridgedReaction" || event.type === "removeBridgedReaction") {
      return [messageFrame("#messageDiff", {
        roomId: event.roomId,
        seq: event.seq,
        ops: [leafEventToDiffOp(event)],
      })];
    }

    // Room-level invalidations
    if (event.type === "createRoomLink" || event.type === "deleteRoomLink") {
      return [messageFrame("#invalidate", {
        nsid: "space.roomy.room.getMetadata",
        params: { roomId: topic.slice(5) },
      })];
    }
  }

  if (topic.startsWith("space:")) {
    const spaceId = topic.slice(6);

    if (event.type === "createRoom") {
      return [
        messageFrame("#invalidate", {
          nsid: "space.roomy.space.getMetadata",
          params: { spaceId },
        }),
        messageFrame("#invalidate", {
          nsid: "space.roomy.space.getThreads",
          params: { spaceId },
        }),
      ];
    }

    if (event.type === "updateSidebar") {
      return [messageFrame("#invalidate", {
        nsid: "space.roomy.space.getMetadata",
        params: { spaceId },
      })];
    }

    if (event.type === "updateProfile") {
      return [messageFrame("#invalidate", {
        nsid: "space.roomy.space.getMetadata",
        params: { spaceId },
      })];
    }
  }

  return [];
}
```

---

## Bun Entry Point (`src/index.ts`)

Updated from existing implementation. Registers all handlers and the sync subscription.

```typescript
import { XrpcRouter, prodAuthVerifier } from "./xrpc/index.ts";
import { createSyncHandler } from "./sync/handler.ts";
import { getConnectionTicketHandler } from "./handlers/auth.getConnectionTicket.ts";

// Query handlers
import { getSpaces } from "./handlers/space.getSpaces.ts";
import { getSpaceMetadata } from "./handlers/space.getMetadata.ts";
import { getSpaceThreads } from "./handlers/space.getThreads.ts";
import { getRoomMetadata } from "./handlers/room.getMetadata.ts";
import { getMessages } from "./handlers/room.getMessages.ts";
import { getRoomThreads } from "./handlers/room.getThreads.ts";
import { getMessage } from "./handlers/message.getMessage.ts";

const PORT = Number(process.env.PORT ?? 8080);
const OWN_DID = process.env.APPSERVER_DID ?? "did:web:appserver.roomy.chat";
const SERVICE_ENDPOINT = process.env.APPSERVER_ORIGIN ?? "https://appserver.roomy.chat";

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

// Leaf event source — subscribes to Leaf streams and broadcasts to sync handlers
const leafEvents = createLeafEventSource();

const syncHandler = createSyncHandler(leafEvents);

const router = new XrpcRouter(prodAuthVerifier)
  // Auth
  .procedure("space.roomy.auth.getConnectionTicket", {
    handler: getConnectionTicketHandler,
  })
  // Space queries
  .query("space.roomy.space.getSpaces", { handler: getSpaces })
  .query("space.roomy.space.getMetadata", {
    handler: getSpaceMetadata,
    parseParams: requireParam("spaceId"),
  })
  .query("space.roomy.space.getThreads", {
    handler: getSpaceThreads,
    parseParams: requireParam("spaceId"),
  })
  // Room queries
  .query("space.roomy.room.getMetadata", {
    handler: getRoomMetadata,
    parseParams: requireParam("roomId"),
  })
  .query("space.roomy.room.getMessages", {
    handler: getMessages,
    parseParams: requireParam("roomId"),
  })
  .query("space.roomy.room.getThreads", {
    handler: getRoomThreads,
    parseParams: requireParam("roomId"),
  })
  // Message query
  .query("space.roomy.message.getMessage", {
    handler: getMessage,
    parseParams: requireParam("messageId"),
  })
  // Multiplexed sync subscription
  .sync("space.roomy.sync.subscribe", { handler: syncHandler });

// Helper for param validation
function requireParam(name: string) {
  return (p: Record<string, unknown>) => {
    if (!p[name]) throw new XrpcError(400, "InvalidRequest", `${name} required`);
    return p;
  };
}

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
        headers: { "content-type": "application/json" },
      });
    }

    const res = await router.fetch(req, server);
    if (res) {
      for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);
    }
    return res;
  },
  websocket: router.websocket,
});

console.log(`Appserver listening on port ${PORT} (DID: ${OWN_DID})`);
```

---

## Handler Patterns

### Query handler (server-side joins, denormalized response)

The `getSpaceMetadata` handler demonstrates the merged metadata + sidebar pattern:

```typescript
import type { QueryHandler } from "../xrpc/types.ts";

interface Params { spaceId: string; }

export const getSpaceMetadata: QueryHandler<Params> = async (params, auth) => {
  // Metadata
  const meta = db.query("SELECT name, avatar, description FROM comp_info WHERE entity = ?")
    .get(params.spaceId);

  // Sidebar tree with orphan detection (previously two separate client-side queries)
  const categories = db.query(`
    SELECT json_group_array(json_object(
      'id', c.entity,
      'name', ci.name,
      'position', c.position,
      'channels', (SELECT json_group_array(json_object(
        'id', ch.entity,
        'name', chi.name,
        'unreadCount', ...,
        'lastRead', ...
      )) FROM ...)
    )) as categories
    FROM ...
  `).get(params.spaceId);

  const orphans = db.query(`
    SELECT ... -- channels not in any category
  `).all(params.spaceId);

  return {
    name: meta?.name ?? null,
    avatar: meta?.avatar ?? null,
    description: meta?.description ?? null,
    sidebar: { categories, orphans },
  };
};
```

The `getRoomMetadata` handler includes recent threads:

```typescript
export const getRoomMetadata: QueryHandler<Params> = async (params, auth) => {
  const room = db.query("SELECT ... FROM comp_room JOIN comp_info ... WHERE entity = ?")
    .get(params.roomId);

  const recentThreads = db.query(`
    SELECT r.entity as id, ri.name, lr.unreadCount, lr.lastRead
    FROM edges e
    JOIN comp_room r ON e.head = r.entity
    JOIN comp_info ri ON r.entity = ri.entity
    LEFT JOIN comp_last_read lr ON ...
    WHERE e.tail = ? AND e.type = 'link'
    ORDER BY r.latestActivity DESC
    LIMIT 5
  `).all(params.roomId);

  return { ...room, recentThreads };
};
```

### Messages query (paginated, most complex)

```typescript
import type { QueryHandler } from "../xrpc/types.ts";

interface Params { roomId: string; limit?: string; cursor?: string; }

export const getMessages: QueryHandler<Params> = async (params, auth) => {
  const limit = Math.min(Number(params.limit ?? 50), 100);
  const cursor = params.cursor;

  const messages = db.query(`
    SELECT
      m.entity as id,
      cc.content,
      m.author_edge_tail as authorDid,
      ui.name as authorName,
      ui.avatar as authorAvatar,
      m.timestamp,
      -- reactions aggregated
      -- media aggregated
      -- forwarded messages via UNION
    FROM entities m
    JOIN comp_content cc ON ...
    JOIN comp_user ui ON ...
    -- ... 10+ table joins ...
    WHERE m.room = ?
      AND (? IS NULL OR m.entity < ?)
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(params.roomId, cursor, cursor, limit);

  return {
    messages,
    cursor: messages.length === limit ? messages[messages.length - 1].id : null,
  };
};
```

---

## Auth Context Flow Through WebSocket

1. Client sends `GET /xrpc/space.roomy.sync.subscribe?ticket=<t>` with `Upgrade: websocket`
2. `router.fetch` receives the HTTP request. `consumeTicket(ticket)` resolves to `{ did }` — or throws `XrpcError(401)` which becomes HTTP 401 (WebSocket never opens)
3. `server.upgrade(req, { data: { auth, abort } })` is called. Bun handles `101 Switching Protocols`
4. Bun calls `websocket.open(ws)` where `ws.data.auth` is the `AuthCtx` from step 2
5. Router creates `SyncSocket` wrapper and calls `syncHandler(socket, auth)`
6. Sync handler registers `onMessage`/`onClose` callbacks
7. Client sends JSON sub/unsub/cursor messages → `websocket.message` → `onMessage` callback
8. Leaf events arrive → sync handler generates frames → `socket.send()` → CBOR binary to client
9. Client disconnects → `websocket.close` → `abort.abort()` + `onClose()` cleanup

---

## Risks and Edge Cases

| Risk | Mitigation |
|------|-----------|
| Bidirectional WS not standard ATProto | Client messages are JSON text (not CBOR) — simple to parse. Server frames are CBOR (ATProto standard). This is an appserver-internal protocol, not a public ATProto subscription. |
| Memory: per-connection subscription state | Bounded by `(active connections) × (avg topics per connection)`. Typical session: 1 space + 1 room = 2 topics. |
| Backpressure on `socket.send()` | SyncSocket.send() checks `isOpen` before sending. For high-throughput rooms, consider batching diffs per tick. |
| Leaf event fan-out to many connections | Topic routing table enables O(subscribers) delivery per event. No global broadcast. |
| Cursor replay on reconnect | Server replays missed `#messageDiff` from SQLite event log by seq number. For non-message data, sends broad `#invalidate` signals. |
| Multiple Leaf events in same tick | Sync handler can batch frames per tick to reduce WS message count. |
| Auth ticket replay | Tickets are single-use (`consumeTicket` deletes immediately). 60-second TTL limits window. |

---

## Implementation Order

1. `xrpc/types.ts` — updated types with SyncSocket, ClientMessage, SyncDef
2. `xrpc/errors.ts` — unchanged
3. `xrpc/frame.ts` — unchanged
4. `xrpc/auth.ts` — unchanged (already implemented)
5. `xrpc/router.ts` — rewrite for `.sync()` support, bidirectional WS
6. `sync/topics.ts` — Leaf event → topic → frame mapping
7. `sync/handler.ts` — per-connection topic subscription management
8. `src/index.ts` — wire up all handlers + sync subscription
9. One query handler end-to-end (`space.roomy.space.getMetadata`) — proves DB + routing + merged sidebar works
10. Sync handler end-to-end (`space.roomy.sync.subscribe`) — proves WS + CBOR + topic routing works
11. Remaining query handlers (getSpaces, getThreads, getMessages, getMessage)
12. Remaining topic mappings (reactions, thread activity, etc.)
