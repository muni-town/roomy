<svelte:head>
  <title>Contributing — Roomy API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Contributing</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    How the appserver works under the hood, and how to add to it. This page is
    for contributors to the Roomy monorepo — the public API docs live in
    <a href="/concepts/spaces">Concepts</a> and the <a href="/endpoints">endpoint catalogue</a>.
  </p>

  <hr />

  <h2>The stack</h2>

  <table>
    <thead>
      <tr>
        <th>Layer</th>
        <th>Technology</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Appserver</td>
        <td>Bun + TypeScript, Dockerised</td>
      </tr>
      <tr>
        <td>Storage</td>
        <td>SQLite (<code>bun:sqlite</code>) — event log + materialised views</td>
      </tr>
      <tr>
        <td>Interface</td>
        <td>XRPC — HTTP queries/procedures + one multiplexed WebSocket</td>
      </tr>
      <tr>
        <td>Clients</td>
        <td>Thin SvelteKit apps (app-lite, this docs site) over TanStack Query</td>
      </tr>
    </tbody>
  </table>

  <p>
    The Bun/TypeScript implementation is explicitly <strong>transitional</strong> —
    it will be replaced by a Rust service with the same XRPC interface. The XRPC
    interface, the thin-client architecture, and the denormalised API design are
    permanent goals.
  </p>

  <h2>How a write becomes a read</h2>

  <ol>
    <li>A client calls a procedure (e.g. <code>sendEvents</code>).</li>
    <li>The handler validates authorization per event, then appends events to the SQLite event log (<code>events.stream_events</code>).</li>
    <li>The stream manager materialises the events into denormalised view tables.</li>
    <li>Invalidation signals are routed to subscribed clients over the WebSocket.</li>
    <li>Clients re-fetch affected queries (or apply message diffs directly).</li>
  </ol>

  <h2>Directory structure</h2>

  <pre><code>packages/appserver/
  src/index.ts              # Bun server entry point (boot + startup backfill)
  src/appserver.ts          # Server factory + buildRouter() — the XRPC surface
  src/xrpc/                 # Router, auth verifiers, rate limiting
  src/handlers/             # One file per NSID
  src/materialization/      # Event → view materialisation
  src/sync/                 # WebSocket sync manager
  src/invalidation/         # Invalidation signal router
  lexicons/                 # ATProto JSON lexicon definitions</code></pre>

  <h2>Adding an endpoint</h2>

  <ol>
    <li>Write the handler in <code>src/handlers/space.roomy.&lt;nsid&gt;.ts</code>.</li>
    <li>Register it in <code>buildRouter()</code> in <code>src/appserver.ts</code> (with an arktype schema from <code>packages/sdk/src/schemas/</code> when it's part of the public interface).</li>
    <li>Add prose for it in <code>packages/docs/src/lib/endpoints/prose.ts</code> — the CI registry check fails without it.</li>
    <li>Regenerate the catalogue skeleton: <code>pnpm --filter docs generate:registry</code>.</li>
  </ol>

  <p>
    The docs catalogue is generated from the router, so a new endpoint appears
    in the docs automatically once it has prose. The CI check
    (<code>pnpm --filter docs check:registry</code>) fails on drift or missing
    prose.
  </p>

  <h2>Running the stack locally</h2>

  <pre><code>./scripts/dev-local          # appserver (8080) + app-lite (5180) + local PLC
pnpm --filter docs dev      # this docs site (5300)</code></pre>

  <p>
    The appserver uses the real PLC directory for JWT verification, so auth
    works with real PDS accounts. See <code>AGENTS.md</code> for the full
    development guide.
  </p>

  <h2>Database schema</h2>

  <p>
    The event log is append-only. Materialised views are denormalised per space:
    <code>comp_space</code>, <code>comp_room</code>, <code>comp_message</code>,
    <code>comp_reaction</code>, <code>comp_user</code>, <code>comp_info</code>,
    plus edges (<code>member</code>, <code>admin</code>, <code>role</code>,
    <code>link</code>, <code>forward</code>) and read positions. The full schema
    lives in <code>packages/appserver/src/db/schema-global.sql</code> and the
    per-space schema files.
  </p>
</div>
