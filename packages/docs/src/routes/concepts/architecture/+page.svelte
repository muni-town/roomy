<svelte:head>
  <title>Architecture — Roomy Appserver API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Architecture</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    The Roomy Appserver owns the server-side event store and materialised views, and exposes them to thin clients through a clean XRPC interface.
  </p>

  <hr />

  <h2>System Architecture</h2>

  <pre><code>Browser (SvelteKit)
  TanStack Query (in-memory cache, reactive queries)
    |  HTTP (service-auth JWT) + single multiplexed WebSocket
Appserver (Bun + TypeScript, Dockerised)
  SQLite event store (events.stream_events) + materialised views (bun:sqlite)
  StreamManager: sendEvents → materialise → invalidation signals
  Auth middleware (ATProto service-auth JWT + WebSocket pre-auth tickets)
    |  DID resolution, profile hydration (HappyView → Bluesky appview)
AT Protocol PDS  ←→  PLC directory</code></pre>

  <h2>Data Flow</h2>

  <h3>Initial Load</h3>
  <ol>
    <li>TanStack Query fires <code>queryFn</code> → HTTP GET direct to the appserver with a service-auth JWT → SQLite</li>
    <li>Response populates cache with <code>staleTime: Infinity</code></li>
  </ol>

  <h3>Real-time Updates</h3>
  <ol>
    <li>A write procedure (<code>sendEvents</code>, <code>createSpace</code>, <code>joinSpace</code>, …) appends events to the stream's SQLite event log</li>
    <li>The <code>StreamManager</code> materialises the batch into the view tables and emits invalidation signals</li>
    <li>Message events → <code>#messageDiff</code> CBOR frame → WebSocket → <code>setQueryData()</code> (no HTTP)</li>
    <li>Unread-count changes → <code>#roomMetadataDiff</code> CBOR frame → WebSocket → cache patch (no HTTP)</li>
    <li>Other events → <code>#invalidate</code> CBOR frame → WebSocket → <code>invalidateQueries()</code> → HTTP re-fetch</li>
  </ol>

  <h3>Reconnection</h3>
  <ol>
    <li>Client fetches a fresh ticket and reconnects; the SDK automatically re-sends all subscribed topics</li>
    <li>Subscribing to a room topic triggers an immediate <code>#invalidate</code> for the room's queries, so the client re-fetches anything missed while disconnected</li>
    <li>Cursor-based replay of missed diffs is a future concern — for now, reconnect means re-fetch</li>
  </ol>

  <h2>Implementation Stack</h2>

  <table>
    <thead>
      <tr>
        <th>Component</th>
        <th>Choice</th>
        <th>Rationale</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Runtime</td>
        <td>Bun</td>
        <td>Native HTTP + WebSocket, built-in SQLite, fast startup</td>
      </tr>
      <tr>
        <td>Server DB</td>
        <td>bun:sqlite</td>
        <td>Built-in, zero-config, sufficient for single-node deployment. Three databases: the event log, the materialised views, and appserver-owned read state (read positions, push subscriptions, flags)</td>
      </tr>
      <tr>
        <td>Client cache</td>
        <td>TanStack Query v5/v6</td>
        <td>Production-grade, Svelte 5 runes, invalidateQueries() + setQueryData()</td>
      </tr>
      <tr>
        <td>Wire format</td>
        <td>CBOR via @atcute/cbor</td>
        <td>ATProto standard, already in monorepo</td>
      </tr>
      <tr>
        <td>Auth</td>
        <td>@atproto/xrpc-server + @atproto/identity</td>
        <td>JWT verification, DID resolution via PLC directory (cached)</td>
      </tr>
      <tr>
        <td>Lexicons</td>
        <td>ATProto JSON schema format</td>
        <td>Standard, enables future on-protocol migration</td>
      </tr>
    </tbody>
  </table>

  <h2>What the Client No Longer Does</h2>

  <table>
    <thead>
      <tr>
        <th>Removed</th>
        <th>Replaced by</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>SQLite WASM worker</td><td>Appserver SQLite (bun:sqlite)</td></tr>
      <tr><td>Client-side materialisation</td><td>Appserver materialises from its local event log</td></tr>
      <tr><td>LiveQuery / livequery() calls</td><td>TanStack Query + WS invalidation signals</td></tr>
      <tr><td>Client-side join logic</td><td>Server handles in query responses</td></tr>
    </tbody>
  </table>

  <h2>Directory Structure</h2>

  <pre><code>packages/appserver/
  src/
    index.ts                  ← Bun.serve() entry, startup re-materialisation
    appserver.ts              ← Server factory (createAppserver, buildRouter)
    xrpc/
      router.ts               ← XrpcRouter: HTTP + WS routing, rate limiting
      auth.ts                 ← JWT validation, DID resolution, ticket store
      authGuards.ts           ← XRPC adapter over auth/access.ts
      types.ts                ← Shared types (AuthCtx, Frame, handlers)
      errors.ts               ← XrpcError class
      frame.ts                ← CBOR frame encoding
    sync/
      handler.ts              ← SyncManager: multiplexed WS + topic routing
    streams/
      StreamManager.ts        ← Event writes → inline materialisation → signals
      reMaterialize.ts        ← Startup replay from the event log
    materialization/          ← Event materialisation (applyBatch)
    invalidation/             ← Signal inference (inferSignals) + pub/sub router
    handlers/                 ← One file per XRPC NSID
    auth/
      access.ts               ← Pure predicates: isMember, isAdmin, canRead, canWrite
      writeAuth.ts            ← Per-event authorisation for sendEvents
    db/
      schema.sql              ← Materialised view schema
      eventsSchema.sql        ← Raw event log (stream_events)
      readStateSchema.sql     ← Read positions, push, flags (appserver-owned)
    queries/                  ← SQL query helpers
    hydration/                ← User membership hydration
    cache/                    ← Server-side query response cache (LRU + TTL)
    embed/                    ← Link-card embed enrichment
    push/                     ← Web Push notification logic
    happyview.ts              ← HappyView profile-index config
  lexicons/                   ← ATProto JSON lexicon definitions</code></pre>

  <h2>Migration Status</h2>

  <ol>
    <li><strong>Done:</strong> Legacy <code>packages/app</code> (SQLite WASM + workers + LiveQuery) deleted. The client has been ported to TanStack Query + XRPC.</li>
    <li><strong>Current:</strong> The Bun appserver is the production implementation, owning the event log, materialisation, XRPC serving, and WebSocket sync.</li>
    <li><strong>Planned:</strong> Hand off to a Rust service exposing the same XRPC interface as a drop-in replacement.</li>
  </ol>
</div>
