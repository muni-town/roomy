<svelte:head>
  <title>Quickstart — Roomy API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Quickstart</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    Call the Roomy API in about ten minutes. You'll need an ATProto identity
    (any Bluesky account works) and a way to get a service-auth token.
  </p>

  <hr />

  <h2>1. Get a service-auth token</h2>

  <p>
    The appserver authenticates HTTP callers with <strong>service-auth JWTs</strong> —
    short-lived tokens your PDS issues for a specific audience (the appserver DID).
    The SDK's <code>ServiceAuthClient</code> does this transparently; for raw curl
    you can mint one with the AT Protocol client of your choice.
  </p>

  <pre><code># Using @atproto/api (Node):
import &#123; AtpAgent &#125; from "@atproto/api";
const agent = new AtpAgent(&#123; service: "https://bsky.social" &#125;);
await agent.login(&#123; identifier: "you.bsky.social", password: "app-password" &#125;);
const &#123; data &#125; = await agent.com.atproto.server.getServiceAuth(&#123;
  aud: "did:web:api.roomy.space",
  lxm: "space.roomy.space.getSpaces",
&#125;);
// data.token is your service-auth JWT</code></pre>

  <h2>2. List your spaces</h2>

  <p>
    The appserver is at <code>https://api.roomy.space</code>. XRPC queries are
    GETs to <code>/xrpc/&lt;nsid&gt;</code> with the token in the
    <code>Authorization</code> header.
  </p>

  <pre><code>curl 'https://api.roomy.space/xrpc/space.roomy.space.getSpaces' \
  -H 'Authorization: Bearer &lt;service-auth-jwt&gt;'</code></pre>

  <p>You'll get a JSON object with a <code>spaces</code> array — each entry has
  <code>id</code> (the space's stream DID), <code>name</code>, <code>isMember</code>,
  <code>isAdmin</code>, and <code>unreadCount</code>.</p>

  <h2>3. Read messages from a room</h2>

  <p>Grab a <code>roomId</code> from the space's metadata, then:</p>

  <pre><code>curl 'https://api.roomy.space/xrpc/space.roomy.room.getMessages?roomId=&lt;room-id&gt;&limit=20' \
  -H 'Authorization: Bearer &lt;service-auth-jwt&gt;'</code></pre>

  <p>Messages come back fully denormalised: author name/avatar, reactions, media,
  reply and forward chains — no client-side joins needed.</p>

  <h2>4. Subscribe to real-time updates</h2>

  <p>
    Real-time data flows over a single multiplexed WebSocket. First mint a
    single-use ticket, then connect:
  </p>

  <pre><code># 1. Get a ticket
curl -X POST 'https://api.roomy.space/xrpc/space.roomy.auth.getConnectionTicket' \
  -H 'Authorization: Bearer &lt;service-auth-jwt&gt;'
# → &#123; "ticket": "&lt;64-char-hex&gt;" &#125;

# 2. Connect (ticket is single-use, 60s TTL)
wscat -c 'wss://api.roomy.space/xrpc/space.roomy.sync.subscribe?ticket=&lt;ticket&gt;'

# 3. Subscribe to a topic (JSON text frame)
&#123;"type":"sub","topic":"space","id":"&lt;space-did&gt;"&#125;</code></pre>

  <p>
    The server pushes typed CBOR frames: <code>#messageDiff</code> for new/updated
    messages, <code>#invalidate</code> when a query's data is stale, and
    <code>#roomMetadataDiff</code> for unread-count changes. See
    <a href="/concepts/real-time">Real-time</a> for the full protocol.
  </p>

  <h2>5. Send a message</h2>

  <p>Writes go through <code>space.roomy.space.sendEvents</code> — a batch of
  typed events. The appserver validates authorization per event, appends to the
  event log, and materialises the result.</p>

  <pre><code>curl -X POST 'https://api.roomy.space/xrpc/space.roomy.space.sendEvents' \
  -H 'Authorization: Bearer &lt;service-auth-jwt&gt;' \
  -H 'Content-Type: application/json' \
  -d '&#123;
    "spaceId": "&lt;space-did&gt;",
    "events": [&#123;
      "$type": "space.roomy.message.createMessage.v0",
      "room": "&lt;room-id&gt;",
      "body": &#123; "text": "Hello from the API!" &#125;
    &#125;]
  &#125;'</code></pre>

  <h2>Next steps</h2>

  <ul>
    <li><a href="/concepts/spaces">Spaces</a> — membership, admins, invites, roles</li>
    <li><a href="/concepts/auth">Auth</a> — tokens, scopes, WebSocket tickets</li>
    <li><a href="/endpoints">Endpoint catalogue</a> — every method, with a live "Try it" panel</li>
    <li><a href="/playground">Playground</a> — raw XRPC + WebSocket console</li>
  </ul>
</div>
