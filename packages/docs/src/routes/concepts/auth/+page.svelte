<svelte:head>
  <title>Authentication — Roomy Appserver API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Authentication</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    The appserver authenticates HTTP callers with ATProto service-auth JWTs (issued by the caller's PDS, sent directly to the appserver), and WebSocket connections with a separate single-use ticket exchange.
  </p>

  <hr />

  <h2>HTTP Request Flow</h2>

  <p>The browser obtains short-lived <strong>service auth tokens</strong> from its PDS via <code>com.atproto.server.getServiceAuth</code> and sends XRPC requests directly to the appserver — no request proxying. This is handled transparently by the SDK's <code>ServiceAuthClient</code> + <code>DirectXrpcClient</code>, which cache and auto-refresh tokens with a 30-second validity margin.</p>

  <pre><code>Browser → PDS (getServiceAuth, aud = appserver DID) → service-auth JWT
Browser → Appserver (Authorization: Bearer &lt;jwt&gt;)</code></pre>

  <ol>
    <li>Client calls <code>com.atproto.server.getServiceAuth</code> on its PDS with <code>aud</code> = appserver DID (<code>did:web:api.roomy.space</code> by default)</li>
    <li>PDS returns a short-lived JWT:
      <ul>
        <li><code>iss</code> = PDS DID</li>
        <li><code>sub</code> = user DID</li>
        <li><code>aud</code> = appserver DID</li>
        <li><code>exp</code> = expiry timestamp (~5 minutes)</li>
      </ul>
    </li>
    <li>Client sends the request directly to the appserver with <code>Authorization: Bearer &lt;jwt&gt;</code></li>
    <li>Appserver validates the JWT and resolves the user DID from <code>sub</code></li>
  </ol>

  <h2>WebSocket Auth Flow</h2>

  <p>PDSes cannot issue long-lived WebSocket credentials, so a separate ticket exchange is used. The ticket is a 64-char hex string, single-use, with a 60-second TTL.</p>

  <pre><code>Browser → Appserver (POST space.roomy.auth.getConnectionTicket, service-auth JWT)
Browser → Appserver (WebSocket with ?ticket=)</code></pre>

  <ol>
    <li>Browser calls <code>POST /xrpc/space.roomy.auth.getConnectionTicket</code> with a service-auth JWT</li>
    <li>Appserver returns a single-use ticket (64-char hex, 60-second TTL)</li>
    <li>Browser opens a WebSocket directly to the appserver: <code>wss://appserver.roomy.chat/xrpc/space.roomy.sync.subscribe?ticket=&lt;ticket&gt;</code></li>
    <li>Router consumes the ticket at upgrade time; the connection is bound to the ticket's DID</li>
  </ol>

  <p>On reconnect the client always fetches a <strong>fresh</strong> ticket — tickets are single-use and short-lived.</p>

  <h2>JWT Validation (prodAuthVerifier)</h2>

  <p>Every HTTP request is validated through the production auth verifier in <code>src/xrpc/auth.ts</code>:</p>

  <ol>
    <li>Extract <code>Bearer &lt;jwt&gt;</code> from the <code>Authorization</code> header; no header → <strong>anonymous</strong> (<code>did: null</code>) — handlers decide what anonymous callers may do</li>
    <li>Verify the JWT with <code>@atproto/xrpc-server</code>'s <code>verifyJwt</code>: <code>aud</code> must match <code>APPSERVER_DID</code> (default <code>did:web:api.roomy.space</code>), <code>exp</code> must be in the future</li>
    <li>Resolve the <code>iss</code> DID document via <code>@atproto/identity</code>'s <code>IdResolver</code> (did:plc via PLC directory, did:web via HTTPS; stale-while-revalidate cache — 30s background refresh, 5-minute hard expiry)</li>
    <li>Extract the ATProto signing key from the DID document and verify the signature</li>
    <li>Resolve the caller's DID: <code>sub</code> when present (service-auth tokens), else <code>iss</code> (atproto-proxy tokens)</li>
  </ol>

  <p>Returns <code>AuthCtx: &#123; did: string | null &#125;</code>. JWT verification failure falls back to <strong>anonymous</strong> (<code>did: null</code>) rather than rejecting — handlers enforce access control via <code>requireRoomRead</code> / <code>requireSpaceAccess</code>.</p>

  <h2>Test Mode</h2>

  <p>When <code>APPSERVER_TEST_MODE=true</code>, a header-based bypass (<code>X-Test-Did</code>) is used instead of JWT verification. This enables E2E testing without a PDS or PLC dependency.</p>

  <h2>Ticket Store</h2>

  <p>The ticket store in <code>src/xrpc/auth.ts</code> manages WebSocket pre-auth:</p>

  <ul>
    <li><code>issueTicket(did)</code> — generates a 32-byte random hex token, stores with DID and 60s TTL</li>
    <li><code>consumeTicket(ticket)</code> — single-use lookup, deletes immediately, throws 401 if missing/expired</li>
    <li>Periodic cleanup every 5 minutes removes expired entries</li>
  </ul>

  <h2>Authorization Model</h2>

  <p>The appserver's authorization unit (<code>src/auth/access.ts</code>) is decision-only and pure. Two key facts:</p>

  <ol>
    <li><strong>Admin and membership are orthogonal.</strong> A caller may be an admin without being a member, or a member without being an admin. Every authorization decision is the union of (a) admin-edge presence and (b) role-derived and default-access signals.</li>
    <li><strong>Per-room access is the union of several signals:</strong>
      <ul>
        <li>Caller has the <code>admin</code> edge on the space, <strong>or</strong></li>
        <li>The room's effective <code>default_access</code> permits the operation — for threads this is the more restrictive of the thread's own and its canonical parent channel's value, <strong>or</strong></li>
        <li>The caller has a role assigned via <code>member_roles</code> whose <code>role_rooms</code> entry for the room (the parent channel for threads) grants the required permission level.</li>
      </ul>
    </li>
  </ol>

  <p>Additional gates: <strong>bans are an explicit deny</strong> (even for admins); <strong>write access requires membership</strong> (non-admins); <strong>read access to invite-only spaces requires membership</strong> (public spaces are readable anonymously); roles are space-scoped and soft-deleted roles are ignored.</p>

  <h3>Per-Endpoint Requirements</h3>

  <table>
    <thead>
      <tr>
        <th>Endpoint</th>
        <th>Caller must be</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>getSpaces</td><td>Authenticated; anonymous callers get an empty list</td></tr>
      <tr><td>getMetadata (space)</td><td>Member OR admin of the space</td></tr>
      <tr><td>getSpaceSummary</td><td>Read access to the space (public spaces are readable anonymously)</td></tr>
      <tr><td>getThreads (space)</td><td>Member OR admin of the space</td></tr>
      <tr><td>getActivityFeed</td><td>Authenticated; per-space variant additionally requires member/admin of that space</td></tr>
      <tr><td>getRoles</td><td>Member OR admin of the space</td></tr>
      <tr><td>getMembers</td><td>Member OR admin of the space</td></tr>
      <tr><td>getInvites</td><td>Member OR admin; admins see all invites, non-admins only their own (403 when member invites are disabled)</td></tr>
      <tr><td>getMetadata / getMessages / getThreads / getRoomSummary (room)</td><td>Has read access to the room (public rooms are readable anonymously)</td></tr>
      <tr><td>getMessage / getReactions</td><td>Has read access to the message's room</td></tr>
      <tr><td>getConnectionTicket</td><td>Authenticated</td></tr>
      <tr><td>sendEvents</td><td>Authenticated; per-event authorization via writeAuth (admin, membership, and room write rules)</td></tr>
      <tr><td>createSpace / joinSpace / leaveSpace / setHandle / updateSeen</td><td>Authenticated (updateSeen additionally requires room read access; setHandle requires space admin)</td></tr>
      <tr><td>push.* / getFlags</td><td>Authenticated (getVapidPublicKey is public)</td></tr>
      <tr><td>admin.* / sync.getEvents</td><td>Admin allowlist (<code>APPSERVER_ADMIN_DIDS</code>)</td></tr>
      <tr><td>sync.subscribe topics</td><td>Per-topic: must have read access (ticket-bound DID)</td></tr>
    </tbody>
  </table>

  <h2>Configuration</h2>

  <table>
    <thead>
      <tr>
        <th>Env Var</th>
        <th>Default</th>
        <th>Purpose</th>
      </tr>
    </thead>
    <tbody>
      <tr><td><code>APPSERVER_DID</code></td><td><code>did:web:api.roomy.space</code></td><td>Expected JWT audience, DID document id</td></tr>
      <tr><td><code>APPSERVER_ORIGIN</code></td><td><code>https://api.roomy.space</code></td><td>DID document serviceEndpoint</td></tr>
      <tr><td><code>PLC_DIRECTORY_URL</code></td><td><code>https://plc.directory</code></td><td>DID resolver for did:plc lookups</td></tr>
      <tr><td><code>PORT</code></td><td><code>8080</code></td><td>Listen port</td></tr>
      <tr><td><code>CORS_ORIGIN</code></td><td><code>*</code></td><td>Access-Control-Allow-Origin</td></tr>
      <tr><td><code>APPSERVER_TEST_MODE</code></td><td>unset</td><td><code>true</code> enables the <code>X-Test-Did</code> header bypass</td></tr>
      <tr><td><code>APPSERVER_ADMIN_DIDS</code></td><td>unset</td><td>Comma-separated admin allowlist; admin endpoints reject everyone when unset</td></tr>
      <tr><td><code>HAPPYVIEW_ENDPOINT</code> / <code>HAPPYVIEW_CLIENT_KEY</code> / <code>HAPPYVIEW_CLIENT_SECRET</code></td><td>unset</td><td>HappyView profile-index service; when unset, profile fetching falls back to the Bluesky appview</td></tr>
      <tr><td><code>APPSERVER_QUERY_CACHE_ENABLED</code> / <code>_MAX_ENTRIES</code> / <code>_TTL_MS</code></td><td><code>true</code> / <code>4096</code> / <code>60000</code></td><td>Server-side query response cache</td></tr>
    </tbody>
  </table>
</div>
