<svelte:head>
  <title>Messages — Roomy API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Messages</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    Messages are the payload of Roomy. They're stored as events, materialised
    into denormalised rows, and served back fully assembled — the client never
    joins anything.
  </p>

  <hr />

  <h2>What a message looks like</h2>

  <p>
    <code>space.roomy.room.getMessages</code> returns message objects with all
    joins already resolved server-side:
  </p>

  <ul>
    <li><code>id</code> — ULID entity ID (also the pagination cursor)</li>
    <li><code>content</code> — raw markdown</li>
    <li><code>authorDid</code>, <code>authorName</code>, <code>authorAvatar</code> — denormalised author</li>
    <li><code>timestamp</code> — ISO timestamp</li>
    <li><code>replyTo</code> — parent message ID</li>
    <li><code>forwardedFrom</code> — original source, with the fully denormalised original message nested</li>
    <li><code>reactions</code> — grouped by emoji, with reactor DIDs</li>
    <li><code>media</code> — attached media URLs</li>
    <li><code>tags</code> — message tags</li>
  </ul>

  <h2>Writing messages</h2>

  <p>
    Writes go through <code>space.roomy.space.sendEvents</code>, which accepts a
    batch of typed events. The appserver validates authorization per event,
    appends to the event log, and materialises inline. The canonical message
    event is <code>space.roomy.message.createMessage.v0</code>.
  </p>

  <p>
    Because writes are events, the same pipeline handles reactions, edits,
    deletes, and every other state change — see
    <a href="/concepts/data-model">Data model</a>.
  </p>

  <h2>Reactions</h2>

  <p>
    Reactions are stored per (message, emoji, user) and returned grouped by
    emoji. <code>space.roomy.message.getReactions</code> returns the full
    reactor list with profile info — it's called on hover, not embedded in the
    message DTO, to keep message payloads small.
  </p>

  <h2>Pagination</h2>

  <p>
    Message cursors are <strong>message entity IDs (ULIDs), not timestamps</strong>.
    This handles concurrent messages correctly: a cursor points at a specific
    message, and the next page is everything older than it.
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
        <td><a href="/endpoints/space/roomy/room/getMessages">getMessages</a></td>
        <td>Paginated history for a room</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/message/getMessage">getMessage</a></td>
        <td>Single message by ID</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/message/getReactions">getReactions</a></td>
        <td>Reactors per emoji, with profiles</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/space/sendEvents">sendEvents</a></td>
        <td>The write path — batch of typed events</td>
      </tr>
    </tbody>
  </table>
</div>
