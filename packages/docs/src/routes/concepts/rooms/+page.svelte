<svelte:head>
  <title>Rooms — Roomy API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Rooms</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    Rooms are where messages live. There are three kinds — channels, threads,
    and pages — and every room has a per-caller read/write permission resolved
    server-side.
  </p>

  <hr />

  <h2>Kinds of rooms</h2>

  <table>
    <thead>
      <tr>
        <th>Kind</th>
        <th>What it is</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><code>channel</code></td>
        <td>A top-level room, pinned to a category in the sidebar</td>
      </tr>
      <tr>
        <td><code>thread</code></td>
        <td>A room linked to a parent channel — inherits its visibility and access</td>
      </tr>
      <tr>
        <td><code>page</code></td>
        <td>A document-style room</td>
      </tr>
    </tbody>
  </table>

  <p>
    Threads are <em>rooms</em>, not message chains: they have their own ID, name,
    and unread count, and they inherit their parent channel's
    <code>defaultAccess</code>. The server resolves this by following the
    <code>link</code> edge to the parent channel.
  </p>

  <h2>Access control</h2>

  <p>
    Every room has a <code>defaultAccess</code> of <code>readwrite</code>,
    <code>read</code>, or <code>none</code>, which roles can override per-room.
    The appserver resolves the caller's effective permission and returns it as
    <code>canRead</code> / <code>canWrite</code> on every room object.
  </p>

  <p>
    <strong>Unreadable rooms are omitted entirely</strong> — the server filters
    the sidebar tree, thread lists, and activity feeds before they reach the
    client. You never see a room you can't read.
  </p>

  <h2>Read state and unread counts</h2>

  <p>
    The appserver is the source of truth for read positions. The client calls
    <code>space.roomy.room.updateSeen</code> with a message ID (or nothing, to
    mark everything read); the server stores the position per (user, room) and
    recomputes unread counts. Unread deltas are pushed to subscribed clients as
    <code>#roomMetadataDiff</code> frames.
  </p>

  <h2>Key endpoints</h2>

  <table>
    <thead>
      <tr>
        <th>Endpoint</th>
        <th>What it does</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><a href="/endpoints/space/roomy/room/getMetadata">getMetadata</a></td>
        <td>Room info, access, unread count, recent threads</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/room/getMessages">getMessages</a></td>
        <td>Paginated message history (fully denormalised)</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/room/getThreads">getThreads</a></td>
        <td>Threads linked from a channel</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/room/updateSeen">updateSeen</a></td>
        <td>Mark messages as read</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/room/getRoomSummary">getRoomSummary</a></td>
        <td>Cheap name/kind/spaceId lookup for badge enrichment</td>
      </tr>
    </tbody>
  </table>
</div>
