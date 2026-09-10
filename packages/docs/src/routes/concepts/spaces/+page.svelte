<svelte:head>
  <title>Spaces — Roomy API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Spaces</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    A space is a Roomy community: a stream of events with its own DID, its own
    rooms, and its own membership. Everything in Roomy lives inside a space.
  </p>

  <hr />

  <h2>The mental model</h2>

  <p>
    A space is an <strong>ATProto stream</strong> — a DID that owns an event log.
    The appserver subscribes to the stream, materialises the events into SQLite
    views, and serves them over XRPC. When you call
    <code>space.roomy.space.createSpace</code>, the appserver registers a new
    stream DID and seeds it with default events (a <code>#general</code> room,
    an admin edge for you, join policy).
  </p>

  <p>
    Spaces contain <strong>rooms</strong> (channels and threads — see
    <a href="/concepts/rooms">Rooms</a>). Rooms contain messages. That's the
    whole hierarchy.
  </p>

  <h2>Membership and admins are orthogonal</h2>

  <p>
    This is the single most important fact about Roomy's access model:
    <strong>admin and membership are independent</strong>. A caller can be:
  </p>

  <ul>
    <li>a member and an admin,</li>
    <li>a member but not an admin,</li>
    <li>an admin but <em>not</em> a member (an "external admin"), or</li>
    <li>neither.</li>
  </ul>

  <p>
    <code>space.roomy.space.getSpaces</code> returns spaces where the caller is
    a member <em>or</em> an admin. <code>getMembers</code> returns members plus
    a separate <code>externalAdmins</code> list. Every authorization decision is
    the union of admin-edge presence and role-derived permissions.
  </p>

  <h2>Joining and leaving</h2>

  <ul>
    <li><strong>Public spaces</strong> (<code>allowPublicJoin</code>) — anyone can join with <code>joinSpace</code>.</li>
    <li><strong>Invite-only spaces</strong> — joining requires an invite token from <code>getInvites</code> / <code>createInvite</code>.</li>
    <li><strong>Leaving</strong> — <code>leaveSpace</code> writes a <code>leftSpace</code> edge; the space still appears in <code>getSpaces</code> with <code>includeLeft=true</code> and <code>isMember=false</code>.</li>
    <li><strong>Admins survive leaving</strong> — the admin edge is orthogonal to membership, so an admin who leaves and rejoins stays an admin.</li>
  </ul>

  <h2>Roles and permissions</h2>

  <p>
    Roles are space-scoped. Each role has per-room permissions
    (<code>readwrite</code>, <code>read</code>, or <code>none</code>) and a list
    of assigned member DIDs. Non-admin callers only see roles they're assigned
    to. Soft-deleted roles are ignored by the authorization engine.
  </p>

  <p>
    Bans are an <strong>explicit deny</strong> — even for admins. Write access
    requires membership (for non-admins). Read access to invite-only spaces
    requires membership; public spaces are readable anonymously.
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
        <td><a href="/endpoints/space/roomy/space/getSpaces">getSpaces</a></td>
        <td>Your spaces, with unread counts and capabilities</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/space/getMetadata">getMetadata</a></td>
        <td>Space info + the complete sidebar tree (server-side access filtering)</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/space/getMembers">getMembers</a></td>
        <td>Members + external admins, with profile data</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/space/getRoles">getRoles</a></td>
        <td>Roles and their per-room permissions</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/space/getInvites">getInvites</a></td>
        <td>Active invite tokens (caller-scoped)</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/space/createSpace">createSpace</a></td>
        <td>Create a space (registers a stream DID)</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/space/joinSpace">joinSpace</a></td>
        <td>Join a space, optionally with an invite token</td>
      </tr>
      <tr>
        <td><a href="/endpoints/space/roomy/space/leaveSpace">leaveSpace</a></td>
        <td>Leave a space</td>
      </tr>
    </tbody>
  </table>

  <p>
    Every endpoint page has a live <strong>Try it</strong> panel — sign in and
    call them against the real appserver.
  </p>
</div>
