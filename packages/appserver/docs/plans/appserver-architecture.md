# Appserver Architecture

**Date:** 2026-04-13
**Status:** Phase 1 — Implementation

## Context

Roomy is migrating from a local-first architecture (SQLite WASM materialised in the browser via a three-tier worker system) to a thin-client / appserver model. The appserver acts as an **adapter layer** over the existing Leaf event-stream backend, providing a clean XRPC semantics interface.

**What is transitional:** The Bun/TypeScript appserver implementation is explicitly transitional — it will be replaced by a Rust service with the same XRPC interface.

**What is long-term:** The XRPC interface, client architecture (TanStack Query), and the semantic/denormalized API design are permanent goals. Client simplicity, interoperability, and a clean API are explicit design requirements.

## Architecture

```
Browser (SvelteKit)
  TanStack Query (in-memory cache, reactive queries)
    ↓ HTTP (via PDS proxy) + single multiplexed WebSocket
Appserver (Bun + TypeScript, Dockerised)
  SQLite / bun:sqlite (persisted materialised views)
  Leaf client subscription → materialisation → XRPC handlers
  Auth middleware (ATProto inter-service JWT + pre-auth tickets)
    ↓ Leaf client (existing)
Leaf Server  ←→  AT Protocol PDS
```

### Data flow

```
Initial load:
  1. TanStack Query fires queryFn → HTTP GET via PDS proxy → appserver → SQLite
  2. Response populates cache with staleTime: Infinity

Real-time updates:
  1. Leaf event arrives at appserver
  2. Appserver materialises to SQLite, determines affected topics
  3a. Message events → #messageDiff CBOR frame → WebSocket → setQueryData() (no HTTP)
  3b. Other events → #invalidate CBOR frame → WebSocket → invalidateQueries() → HTTP re-fetch

Reconnection:
  1. Client reconnects with cursor (last received seq)
  2. Server replays missed message diffs from SQLite event log
  3. Server sends broad invalidation signals for non-message data
```

## Design Decisions

### 1. Single multiplexed WebSocket (not per-procedure subscriptions)

Browser WebSocket limits (~6 per domain) make the original design of one XRPC WebSocket subscription per LiveQuery unviable. Instead, a single `space.roomy.sync.subscribe` connection carries all real-time data as typed frames:

- `#messageDiff` — message add/update/remove ops, applied directly to TanStack Query cache
- `#invalidate` — signals that a specific query is stale, triggering HTTP re-fetch (server sends multiple frames for events affecting multiple queries)

Client sends subscribe/unsubscribe messages to control which topics the server sends frames for.

### 2. TanStack Query (not TanStack DB)

Since the server owns all joins and returns denormalized results, TanStack DB's incremental view maintenance (IVM) adds no value. TanStack Query provides:

- `createQuery()` with Svelte 5 runes integration
- `queryClient.invalidateQueries()` — triggered by WS invalidation signals
- `queryClient.setQueryData()` — for direct cache updates from message diffs
- `staleTime: Infinity` — WS is sole freshness authority
- Production-grade (v5/v6), not beta

TanStack DB was assessed (v0.5.33, beta) and found to have Svelte adapter reactivity bugs and lifecycle issues. Not recommended for this use case.

### 3. Server-side joins, denormalized API

The appserver owns all SQL joins. Every query endpoint returns fully assembled objects — the client never joins data across queries. This keeps the client thin and the API interoperable.

### 4. Auth from day one

- **HTTP queries:** PDS proxy with inter-service JWTs (browser → PDS → appserver)
- **WebSocket:** Pre-auth ticket exchange (browser gets ticket via PDS-proxied POST, opens WS directly with ticket)
- See [`auth-design.md`](auth-design.md) and [`authentication.md`](authentication.md)

## XRPC Interface

See the full specification: [`xrpc-interface-spec.md`](xrpc-interface-spec.md)

**Summary: 7 HTTP queries + 1 procedure + 1 subscription = 9 XRPC methods.**

| Type | Count | Methods |
|------|-------|---------|
| HTTP GET queries | 7 | Space/room/message metadata and data retrieval |
| HTTP POST procedure | 1 | `space.roomy.auth.getConnectionTicket` |
| WebSocket subscription | 1 | `space.roomy.sync.subscribe` (multiplexed) |

### HTTP Queries

All authenticated via PDS proxy (inter-service JWT in `Authorization` header).

| NSID | Description |
|------|-------------|
| `space.roomy.space.getSpaces` | All joined spaces with metadata and permissions |
| `space.roomy.space.getMetadata` | Space name, avatar, description + sidebar tree |
| `space.roomy.space.getThreads` | Threads for space board/index view |
| `space.roomy.room.getMetadata` | Room name, kind, lastRead, unreadCount + recent threads |
| `space.roomy.room.getMessages` | Paginated message history (most complex query) |
| `space.roomy.room.getThreads` | Threads within a channel |
| `space.roomy.message.getMessage` | Single message by ID |

### WebSocket: `space.roomy.sync.subscribe`

Client subscribes to topics (`space:<id>`, `room:<id>`), server pushes:

| Frame type | Purpose | Client action |
|---|---|---|
| `#messageDiff` | Message add/update/remove | `setQueryData()` — no HTTP |
| `#invalidate` | Query data is stale | `invalidateQueries()` → HTTP re-fetch |
| `#error` | Error | Close connection |

## What Disappears from the Client

| Removed | Replaced by |
|---------|-------------|
| SQLite WASM worker | Appserver SQLite (bun:sqlite) |
| Peer/shared worker materialisation | Appserver subscribes to Leaf, materialises server-side |
| `LiveQuery` / `livequery()` calls | TanStack Query + WS invalidation signals |
| `src/lib/workers/sqlite/` | n/a |
| `src/lib/queries/*.svelte.ts` | Thin XRPC client wrappers feeding TanStack Query |
| Client-side join logic (sidebar orphan detection, etc.) | Server handles in query responses |

## Implementation Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Native HTTP + WebSocket, built-in SQLite, fast startup |
| Server DB | bun:sqlite | Built-in, zero-config, sufficient for single-node deployment |
| Client cache | TanStack Query v5/v6 | Production-grade, Svelte 5 runes, `invalidateQueries()` + `setQueryData()` |
| Wire format | CBOR via @atcute/cbor | ATProto standard, already in monorepo |
| Auth | @noble/curves + @atcute/identity | ES256K/ES256 JWT verification, DID resolution |
| Lexicons | ATProto JSON schema format | Standard, enables future on-protocol migration |

## Migration Strategy

1. **Phase 0 (done):** Architecture docs, research, scaffold package, implement auth foundation.
2. **Phase 1 (now):** Implement appserver — Bun HTTP + WebSocket, Leaf connection, SQLite schema, XRPC routing, one working query end-to-end.
3. **Phase 2:** Implement all query handlers + WS sync handler. Port client from LiveQuery to TanStack Query + XRPC.
4. **Phase 3:** Remove SQLite WASM worker and peer worker from client.
5. **Phase 4:** Hand off to Rust appserver (same XRPC interface, drop-in replacement).

## Related Documents

| Document | Description |
|----------|-------------|
| [`xrpc-interface-spec.md`](xrpc-interface-spec.md) | Definitive XRPC interface specification — all endpoints, WS protocol, client integration |
| [`xrpc-layer-plan.md`](xrpc-layer-plan.md) | Implementation plan for the XRPC routing layer on Bun native |
| [`auth-design.md`](auth-design.md) | Auth design — PDS proxy, inter-service JWTs, WebSocket tickets |
| [`authentication.md`](../authentication.md) | Auth implementation reference |
| [`livequery-inventory.md`](../livequery-inventory.md) | All 16 LiveQuery instances mapped to XRPC endpoints |

## Files

```
packages/appserver/
  package.json
  tsconfig.json
  Dockerfile
  src/
    index.ts                              ← Bun.serve() entry, DID doc, CORS
    xrpc/
      router.ts                           ← XrpcRouter: HTTP + WS routing + sync pub/sub
      types.ts                            ← Shared types (AuthCtx, Frame, handlers)
      auth.ts                             ← JWT validation, DID resolution, ticket store
      errors.ts                           ← XrpcError class
      frame.ts                            ← CBOR frame encoding
      index.ts                            ← Barrel re-export
    sync/
      handler.ts                          ← Multiplexed WS sync handler (topic pub/sub)
      topics.ts                           ← Topic matching + invalidation routing
    handlers/
      space.getSpaces.ts
      space.getMetadata.ts                ← includes sidebar tree
      space.getThreads.ts
      room.getMetadata.ts                 ← includes recent threads
      room.getMessages.ts
      room.getThreads.ts
      message.getMessage.ts
      auth.getConnectionTicket.ts         ← Already exists
    db/
      schema.ts                           ← SQLite schema + materialised view tables
      queries.ts                          ← Query helpers for handlers
  lexicons/
    space/roomy/
      auth/getConnectionTicket.json       ← Already exists
      space/getSpaces.json
      space/getMetadata.json
      space/getThreads.json
      room/getMetadata.json
      room/getMessages.json
      room/getThreads.json
      message/getMessage.json
      sync/subscribe.json
```
