<svelte:head>
  <title>Discord bridge — Roomy API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Building a bridge</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    A bridge is an ordinary Roomy client with its own ATProto identity. There
    is no bridge-only API on the appserver: it authenticates with service auth,
    writes with <code>space.roomy.space.sendEvents</code>, and reads the same
    queries every other client reads. This page covers the parts that are
    bridge-specific — the three token procedures, the blob proxy, the origin
    extension that stops echoes — and the status API the reference bridge
    exposes.
  </p>

  <hr />

  <h2>The bridge's identity</h2>

  <p>
    The bridge signs in to ATProto as its own account and calls the appserver
    directly. In <code>packages/discord-bridge</code> that account is configured
    with <code>ATPROTO_BRIDGE_DID</code> and
    <code>ATPROTO_BRIDGE_APP_PASSWORD</code>
    (<code>src/env.ts</code>, consumed by <code>src/roomy/client.ts</code> via
    <code>AtpAgent.login</code>), and the resulting session is cached in
    <code>session.json</code> under <code>BRIDGE_DATA_DIR</code> so restarts
    reuse it. The PDS is hardcoded to <code>https://bsky.social</code> in that
    file — a bridge whose account lives on another PDS must change it.
  </p>

  <p>
    That identity must be a <strong>member (or admin) of every space it writes
    into</strong>, with write access to the rooms it posts in. Admin standing is
    additionally required for the event types it uses: sidebar writes, room
    update/delete/restore, channel and page creation, the
    <code>space.roomy.extension.authorOverride.v0</code> and
    <code>space.roomy.extension.timestampOverride.v0</code> message
    extensions, and the bridged reaction
    events (<code>space.roomy.reaction.addBridgedReaction.v0</code> /
    <code>removeBridgedReaction.v0</code>). The full mapping lives in
    <code>packages/appserver/src/auth/writeAuth.ts</code>.
  </p>

  <p>
    The reference bridge is bidirectional. Discord → Roomy is
    <code>sendEvents</code>; Roomy → Discord holds one sync subscription per
    bridged space and routes create/edit/delete events out to Discord.
  </p>

  <h2>Service auth: what a bridge must send</h2>

  <p>
    Every HTTP request carries an ATProto service-auth JWT minted by the
    bridge's own PDS:
  </p>

  <pre><code>// aud = the appserver's DID, lxm = the NSID being called
const &#123; data &#125; = await agent.com.atproto.server.getServiceAuth(&#123;
  aud: "did:web:api.roomy.space",
  lxm: "space.roomy.space.sendEvents",
  exp: Math.floor(Date.now() / 1000) + 300,
&#125;);

fetch("https://api.roomy.space/xrpc/space.roomy.space.sendEvents", &#123;
  method: "POST",
  headers: &#123;
    "Authorization": `Bearer $&#123;data.token&#125;`,
    "Content-Type": "application/json",
  &#125;,
  body: JSON.stringify(&#123; spaceId, events &#125;),
&#125;);</code></pre>

  <p>
    The SDK's <code>ServiceAuthClient</code>
    (<code>packages/sdk/src/transport/service-auth.ts</code>) does this for you:
    it requests a 300-second token, caches it per <code>aud:lxm</code>, and
    refreshes 30 seconds before expiry. The bridge builds a
    <code>DirectXrpcClient(appserverUrl, appserverDid, serviceAuth)</code> over
    it (<code>packages/discord-bridge/src/roomy/space-manager.ts</code>).
  </p>

  <p>
    The appserver verifies the token in
    <code>packages/appserver/src/xrpc/auth.ts</code> with
    <code>verifyJwt(jwt, OWN_DID, null, …)</code>:
  </p>

  <ul>
    <li>The issuer's DID document is resolved and its ATProto signing key verifies the signature (retried once against a refreshed document, so a rotated key is honoured).</li>
    <li><code>aud</code> must equal the appserver's DID — <code>APPSERVER_DID</code>, defaulting to <code>did:web:api.roomy.space</code>.</li>
    <li><code>exp</code> is enforced; the token must not be expired.</li>
    <li>The caller's DID is <code>sub</code> when present (service-auth tokens), otherwise <code>iss</code> (atproto-proxy tokens).</li>
  </ul>

  <p>
    <strong><code>lxm</code> is not enforced.</strong> The appserver passes
    <code>null</code> for the <code>lxm</code> argument, which
    <code>@atproto/xrpc-server</code> defines as "skip the lxm check" — a token
    minted for one NSID is accepted when presented on another. Mint with
    <code>lxm</code> anyway: it is the ATProto convention, other services
    enforce it, and it keeps your tokens scoped if the appserver tightens
    verification.
  </p>

  <p>
    A failed verification does not reject the request outright — it falls back
    to <strong>anonymous</strong> (<code>did: null</code>). Handlers then deny
    the call (<code>401</code> for authenticated operations), so a bridge with a
    broken token sees authorization errors, not a hard handshake failure.
  </p>

  <h2>Writing and reading</h2>

  <p>
    <code>space.roomy.space.sendEvents</code> takes
    <code>&#123; spaceId, events &#125;</code> and accepts at most
    <strong>50 events</strong> per call
    (<code>packages/appserver/src/handlers/space.roomy.space.sendEvents.ts</code>).
    Every event is authorised individually against
    <code>src/auth/writeAuth.ts</code>; the batch is all-or-nothing — the first
    event the caller may not send fails the whole request with that event's
    status and nothing is written. Authorised events are appended to the
    space's log and materialised inline. A write racing a space rebuild returns
    <code>409 SpaceRematerializing</code>, which is safe to retry.
  </p>

  <p>
    Two consequences for batching. Authorisation reads the <em>materialised</em>
    state, so a room created in the same batch is not yet visible — send
    <code>createRoom.v0</code> first and the message that targets it in a
    later request. And channel federation can authorise a room write for a
    caller who is not a member of the owning space, when the origin and
    receiver grants both allow it.
  </p>

  <p>
    Reads use the ordinary queries: <code>space.roomy.room.getMessages</code>
    (page size capped at 100) and <code>space.roomy.space.getMetadata</code>.
    For push, mint a ticket with
    <code>space.roomy.auth.getConnectionTicket</code>, connect to
    <code>/xrpc/space.roomy.sync.subscribe?ticket=…</code>, and subscribe with
    <code>&#123; kind: "stream", id: &#123;spaceDid&#125;, cursor &#125;</code>;
    the server backfills from the cursor, then streams live events. Tickets are
    64-character hex, single-use, and expire after 60 seconds — fetch a fresh
    one on every reconnect. See <a href="/concepts/real-time">Real-time</a>.
  </p>

  <h2>Bridge tokens: capacity, not credentials</h2>

  <p>
    Roomy Pro membership grants <strong>bridge capacity</strong> to a space.
    The grant is a row in the appserver's read-state database — there is no
    bearer string a bridge presents, and nothing about it is sent over the
    wire by a bridge. It exists so the appserver can answer "how many members
    may this space bridge?".
  </p>

  <table>
    <thead>
      <tr><th>XRPC</th><th>Kind</th><th>Behaviour</th></tr>
    </thead>
    <tbody>
      <tr>
        <td><code>space.roomy.space.grantBridgeToken</code></td>
        <td>procedure</td>
        <td>
          Grants the caller's token to <code>spaceId</code>. Requires
          authentication, membership (or admin) of the space, and a live Polar
          state with capacity &gt; 0 — otherwise <code>403 NotProMember</code>,
          or <code>503</code> when Polar is unreachable and nothing is cached.
          One grant per grantor: an existing pending grant (to this or any other
          space) is <code>409 AlreadyGranted</code>; a spent one is
          <code>409 AlreadySpent</code>. Returns
          <code>&#123; status: "pending", capacity &#125;</code>.
        </td>
      </tr>
      <tr>
        <td><code>space.roomy.space.revokeBridgeToken</code></td>
        <td>procedure</td>
        <td>
          Deletes the caller's own grant for <code>spaceId</code>. Grantor only —
          anyone else gets <code>403</code>. A spent grant is permanent:
          <code>409</code>. Returns <code>&#123; revoked: true &#125;</code>.
        </td>
      </tr>
      <tr>
        <td><code>space.roomy.space.getBridgeTokens</code></td>
        <td>query</td>
        <td>
          Lists the grants a space has received — grantor DID, grant-time
          capacity snapshot, spent flag. Space members may read it. It makes no
          Polar calls, so it never reflects later subscription changes; live
          validity is resolved by the admin membership query below.
        </td>
      </tr>
    </tbody>
  </table>

  <p>
    Capacity comes from the grantor's Polar state
    (<code>packages/appserver/src/billing/polar.ts</code>): an active or
    trialing Roomy Pro subscription is worth
    <code>ROOMY_PRO_CAPACITY</code> (1000) members, and a
    <code>max_members</code> feature-flag benefit raises it if higher. A space's
    <code>maxMembers</code> is the sum of its grants' live capacities.
  </p>

  <p>
    A pending grant becomes <strong>spent</strong> — permanently — the first
    time the appserver sees the space's member count above
    <code>BRIDGE_TOKEN_SPEND_THRESHOLD</code> (100). A spent grant contributes
    zero capacity, and the API offers no way out: revoking it returns
    <code>409</code>, and granting again returns <code>409 AlreadySpent</code>.
  </p>

  <p>
    The reference bridge enforces capacity from
    <code>space.roomy.admin.getSpaceMembership</code>, which returns
    <code>memberCount</code>, <code>maxMembers</code>,
    <code>overLimit</code>, per-token status and a <code>stale</code> flag. It
    is <strong>admin-only</strong> (<code>APPSERVER_ADMIN_DIDS</code>) and
    returns <code>503</code> when Polar is not configured, so a third-party
    bridge cannot call it and must enforce its own limits. The bridge's policy
    on top of it: above capacity sync continues with an admin alert, at twice
    capacity it halts.
  </p>

  <h2>Media: the <code>/blob</code> proxy</h2>

  <p>
    Message attachments reference blobs as
    <code>atblob://&lt;did&gt;/&lt;cid&gt;</code>. Those URIs are not
    fetchable, and <code>cdn.bsky.app</code> serves images only. The appserver
    exposes a proxy
    (<code>packages/appserver/src/blob.ts</code>):
  </p>

  <pre><code>GET /blob/&lt;did&gt;/&lt;cid&gt;</code></pre>

  <ul>
    <li><strong>Unauthenticated.</strong> Blobs referenced by public records are public, and a CID is content-addressed — knowing it grants nothing the record does not already imply.</li>
    <li>Resolves the owner's PDS from their DID document and re-serves <code>com.atproto.sync.getBlob</code>.</li>
    <li>Forwards <code>Range</code> (so <code>&lt;video&gt;</code> can seek) and preserves content type, length and range headers.</li>
    <li>Sets <code>cache-control: public, max-age=31536000, immutable</code>; an unresolvable DID or unreachable PDS is <code>502</code>, a missing blob <code>404</code>.</li>
  </ul>

  <p>
    The bridge rewrites <code>atblob://&lt;did&gt;/&lt;cid&gt;</code> to
    <code>&#123;APPSERVER_URL&#125;/blob/&lt;did&gt;/&lt;cid&gt;</code> before
    downloading an attachment
    (<code>resolveAttachmentUrl</code> in
    <code>packages/discord-bridge/src/services/roomy-event-router.ts</code>).
    Any bridge that mirrors media should do the same rather than resolving PDS
    endpoints itself.
  </p>

  <h2>The bridge's status API</h2>

  <div class="not-prose my-4 rounded-2xl border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-4">
    <p class="text-sm text-red-800 dark:text-red-300 m-0">
      <strong>No authentication.</strong> The bridge's HTTP listener
      (<code>packages/discord-bridge/src/api.ts</code>) has no auth check of any
      kind and answers <code>Access-Control-Allow-Origin: *</code>. It binds
      <code>PORT</code> (default <code>3301</code>) on all interfaces. Never
      expose it publicly; reach it over a private network or a tunnel that
      authenticates.
    </p>
  </div>

  <table>
    <thead>
      <tr><th>Path</th><th>Returns</th></tr>
    </thead>
    <tbody>
      <tr>
        <td><code>GET /info</code></td>
        <td><code>&#123; discordAppId, bridgeDid &#125;</code>. <code>500</code> while the Discord bot is still starting.</td>
      </tr>
      <tr>
        <td><code>GET /get-guild-id?spaceId=&lt;did&gt;</code></td>
        <td><code>&#123; guildId &#125;</code>, or <code>404</code> when the space is not bridged.</td>
      </tr>
      <tr>
        <td><code>GET /get-space-id?guildId=&lt;id&gt;</code></td>
        <td><code>&#123; spaceIds: [...] &#125;</code> — a guild may bridge several spaces; <code>404</code> when none.</td>
      </tr>
      <tr>
        <td><code>GET /bridges[?guildId=&lt;id&gt;]</code></td>
        <td><code>&#123; bridges: [...] &#125;</code> — all bridge configs, or one guild's.</td>
      </tr>
      <tr>
        <td><code>GET /backfill/progress[?spaceDid=&amp;guildId=]</code></td>
        <td>
          <code>&#123; channels: [...] &#125;</code>, one row per (channel, space):
          <code>phase</code> (<code>phase1</code> | <code>phase2</code> |
          <code>complete</code> | <code>blocked</code>),
          <code>messagesSynced</code>, <code>messagesSkipped</code>,
          <code>cursor</code>, <code>running</code>, and for blocked pairs a
          <code>blockedReason</code>. There is deliberately no remaining-percent
          figure: Discord offers no message count to divide by.
        </td>
      </tr>
      <tr>
        <td><code>GET /sends/failed[?spaceDid=&lt;did&gt;]</code></td>
        <td>
          <code>&#123; pending, terminal, sends: [...] &#125;</code> — sends the
          bridge owes a space after retries were exhausted. Each entry carries
          <code>id</code>, <code>op</code>, <code>attempts</code>,
          <code>lastError</code> and timestamps; event payloads are omitted.
        </td>
      </tr>
      <tr>
        <td><code>POST /sends/replay?id=&lt;id&gt;</code></td>
        <td>
          Resets a failed send to due with a fresh attempt budget and returns
          <code>&#123; replayed &#125;</code>; <code>404</code> if no queued send
          has that id, <code>405</code> for other methods.
        </td>
      </tr>
    </tbody>
  </table>

  <h2>Provenance and echo suppression</h2>

  <p>
    A message bridged from Discord carries the extension
    <code>space.roomy.extension.discordMessageOrigin.v0</code>
    (<code>packages/sdk/src/schema/extensions/message.ts</code>):
  </p>

  <pre><code>&#123;
  "$type": "space.roomy.extension.discordMessageOrigin.v0",
  "snowflake": "&lt;discord message id&gt;",
  "channelId": "&lt;discord channel id&gt;",
  "guildId": "&lt;discord guild id&gt;"
&#125;</code></pre>

  <p>
    The bridge attaches it to the create, edit and delete events it writes
    (<code>services/message-ingestion.ts</code>,
    <code>services/message-edit-delete.ts</code>). Its Roomy → Discord path
    skips any create, edit or delete event that carries it
    (<code>services/roomy-event-router.ts</code>), which is what stops a
    bridged message from being posted back to Discord: the extension is the
    echo marker, and the bridge's own write becomes the proof it should not be
    relayed.
  </p>

  <p>
    It is a dedup and provenance breadcrumb, not an authority claim. The
    appserver's write path treats it as presentation —
    unlike <code>space.roomy.extension.authorOverride.v0</code> and
    <code>space.roomy.extension.timestampOverride.v0</code>, it
    needs no admin standing to attach, and it cannot change who a message is
    attributed to or where it sorts. Anything relying on it for cross-process
    idempotency should combine it with a durable mapping of Discord id → Roomy
    id, as the reference bridge does.
  </p>

  <h2>Configuration</h2>

  <table>
    <thead>
      <tr><th>Variable</th><th>Required</th><th>Meaning</th></tr>
    </thead>
    <tbody>
      <tr><td><code>DISCORD_TOKEN</code></td><td>yes</td><td>Bot token for the Discord gateway</td></tr>
      <tr><td><code>ATPROTO_BRIDGE_DID</code></td><td>yes</td><td>The bridge's own ATProto identity</td></tr>
      <tr><td><code>ATPROTO_BRIDGE_APP_PASSWORD</code></td><td>yes</td><td>App password used to create that identity's session</td></tr>
      <tr><td><code>APPSERVER_URL</code></td><td>yes</td><td>Appserver HTTP origin; the sync URL is derived from it</td></tr>
      <tr><td><code>APPSERVER_DID</code></td><td>yes</td><td>The appserver's DID — the service-auth audience</td></tr>
      <tr><td><code>PORT</code></td><td>no (3301)</td><td>Port for the unauthenticated status API</td></tr>
      <tr><td><code>BRIDGE_DATA_DIR</code></td><td>no (<code>./data</code>)</td><td>Holds <code>session.json</code> and <code>bridge.sqlite</code></td></tr>
      <tr><td><code>BRIDGE_DB_PATH</code></td><td>no</td><td>SQLite path; defaults to <code>&#123;BRIDGE_DATA_DIR&#125;/bridge.sqlite</code></td></tr>
      <tr><td><code>STREAM_NSID</code></td><td>no</td><td>Stream NSID to subscribe to (default <code>space.roomy.space.personal.dev</code>)</td></tr>
      <tr><td><code>STREAM_HANDLE_NSID</code></td><td>no</td><td>Handle NSID (default <code>space.roomy.space.handle.dev</code>)</td></tr>
      <tr><td><code>LOG_LEVEL</code></td><td>no (<code>info</code>)</td><td><code>debug</code> | <code>info</code> | <code>warn</code> | <code>error</code></td></tr>
    </tbody>
  </table>

  <h2>See also</h2>

  <ul>
    <li><a href="/concepts/auth">Authentication</a> — the token and ticket flows in full.</li>
    <li><a href="/concepts/real-time">Real-time</a> — frames, cursors, invalidation signals.</li>
    <li><a href="/endpoints/space/roomy/space/grantBridgeToken"><code>space.roomy.space.grantBridgeToken</code></a>, <a href="/endpoints/space/roomy/space/revokeBridgeToken"><code>revokeBridgeToken</code></a>, <a href="/endpoints/space/roomy/space/getBridgeTokens"><code>getBridgeTokens</code></a> — endpoint reference.</li>
    <li><a href="/endpoints/space/roomy/space/sendEvents"><code>space.roomy.space.sendEvents</code></a> — the write path.</li>
  </ul>
</div>
