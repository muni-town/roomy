<script lang="ts">
  import { endpoints } from "$lib/endpoints/registry";
  import { auth } from "$lib/auth.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
</script>

<svelte:head>
  <title>Roomy API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Roomy API</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    Roomy is a community chat platform built on AT Protocol. This is the
    documentation for its server-side API — the XRPC interface that powers
    every Roomy client. Read the concepts, browse the endpoint catalogue, and
    try any call right here.
  </p>

  <hr />

  <h2>What is Roomy?</h2>

  <p>
    Roomy is organized as <strong>spaces</strong> — communities that own a
    stream of events. Spaces contain <strong>rooms</strong> (channels and
    threads), rooms contain <strong>messages</strong>, and everything is
    materialised server-side by the appserver and served over a clean XRPC
    interface. Clients are thin: they fetch denormalised data over HTTP and
    receive real-time diffs over a single multiplexed WebSocket.
  </p>

  <p>
    The appserver is the source of truth for every stream: it stores the raw
    event log in SQLite, materialises events into view tables as they arrive,
    and serves fully assembled query responses. Write procedures append events;
    a single WebSocket pushes row-level diffs and invalidation signals back to
    subscribed clients.
  </p>

  <h2>Start here</h2>

  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 not-prose">
    <a href="/quickstart" class="no-underline">
      <div class="rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900/50 p-5 hover:shadow-md transition-shadow">
        <h3 class="text-base font-semibold mb-1">Quickstart</h3>
        <p class="text-sm text-base-500">Call the API in ~10 minutes — token, spaces, messages, real-time, writes.</p>
      </div>
    </a>
    <a href="/endpoints" class="no-underline">
      <div class="rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900/50 p-5 hover:shadow-md transition-shadow">
        <h3 class="text-base font-semibold mb-1">Endpoint catalogue</h3>
        <p class="text-sm text-base-500">{endpoints.reduce((s, g) => s + g.items.length, 0)} XRPC methods across {endpoints.length} categories — each with a live "Try it" panel.</p>
      </div>
    </a>
    <a href="/concepts/spaces" class="no-underline">
      <div class="rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900/50 p-5 hover:shadow-md transition-shadow">
        <h3 class="text-base font-semibold mb-1">Concepts</h3>
        <p class="text-sm text-base-500">Spaces, rooms, messages, real-time sync, auth, and the data model.</p>
      </div>
    </a>
    <a href="/playground" class="no-underline">
      <div class="rounded-2xl border border-base-200 dark:border-base-800 bg-white dark:bg-base-900/50 p-5 hover:shadow-md transition-shadow">
        <h3 class="text-base font-semibold mb-1">Playground</h3>
        <p class="text-sm text-base-500">Raw XRPC calls, the WebSocket console, push diagnostics, feature flags.</p>
      </div>
    </a>
  </div>

  {#if !auth.authenticated}
    <div class="mt-6 rounded-2xl border border-accent-200 dark:border-accent-800 bg-accent-50 dark:bg-accent-950/30 p-5 not-prose">
      <p class="text-sm text-base-700 dark:text-base-300 mb-3">
        Sign in with any ATProto identity to try endpoints live. Admin-only
        endpoints simply return 403 for non-admins.
      </p>
      <a href="/playground"><Button>Sign in to try the API</Button></a>
    </div>
  {/if}

  <h2>Architecture at a glance</h2>

  <pre><code>Browser (SvelteKit)
  TanStack Query (in-memory cache, reactive queries)
    |  HTTP (service-auth JWT) + single multiplexed WebSocket
Appserver (Bun + TypeScript, Dockerised)
  SQLite event store + materialised views
  StreamManager: sendEvents → materialise → invalidation signals
  Auth middleware (ATProto service-auth JWT + WebSocket pre-auth tickets)
    |  DID resolution, profile hydration (HappyView → Bluesky appview)
AT Protocol PDS  ←→  PLC directory</code></pre>

  <h2>API surface</h2>

  <table>
    <thead>
      <tr>
        <th>Category</th>
        <th>Count</th>
        <th>Description</th>
      </tr>
    </thead>
    <tbody>
      {#each endpoints as group}
        {@const first = group.items[0]}
        {#if first}
          <tr>
            <td><a href="/endpoints/{first.nsid.replace(/\./g, '/')}">{group.name}</a></td>
            <td>{group.items.length}</td>
            <td>{first.description}</td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>

  <h2>Key design decisions</h2>

  <dl>
    <dt class="font-semibold mt-4">Single multiplexed WebSocket</dt>
    <dd>Browser WebSocket limits (~6 per domain) make per-procedure subscriptions unviable. A single <code>space.roomy.sync.subscribe</code> connection carries all real-time data as typed CBOR frames.</dd>

    <dt class="font-semibold mt-4">Server-side joins, denormalized API</dt>
    <dd>The appserver owns all SQL joins. Every query endpoint returns fully assembled objects — the client never joins data across queries.</dd>

    <dt class="font-semibold mt-4">Admin ⊥ Membership</dt>
    <dd>Admin and membership are orthogonal. Every authorization decision is the union of admin-edge presence and role-derived permissions.</dd>

    <dt class="font-semibold mt-4">Events are the write path</dt>
    <dd>All state changes are typed events appended to a stream's log. The appserver materialises them into views; clients never write state directly.</dd>
  </dl>
</div>
