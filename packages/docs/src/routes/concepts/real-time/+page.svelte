<svelte:head>
  <title>Sync Protocol — Roomy Appserver API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Sync Protocol</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    A single multiplexed WebSocket connection carries all real-time data. The client subscribes/unsubscribes to topics; the server pushes message diffs, unread-count deltas, and invalidation signals.
  </p>

  <hr />

  <h2>Connection Lifecycle</h2>

  <pre><code>1. Client obtains ticket via POST /xrpc/space.roomy.auth.getConnectionTicket
2. Client opens WebSocket:
   wss://appserver.roomy.chat/xrpc/space.roomy.sync.subscribe?ticket=&lt;ticket&gt;
3. Server validates + consumes the ticket, accepts connection (bound to ticket's DID)
4. Client sends sub messages for its active topics (auto-replayed by the SDK on every (re)connect)
5. Server pushes frames for subscribed topics going forward
6. On abnormal close: SDK reconnects with exponential backoff (1s base, 30s cap, jitter),
   fetches a fresh ticket, and re-sends all topics
7. Subscribing to a room topic triggers an immediate #invalidate for that room's queries,
   so the client re-fetches anything missed while disconnected</code></pre>

  <h2>Client &rarr; Server Messages</h2>

  <p>JSON-encoded text frames:</p>

  <pre><code>// Subscribe to a topic
&#123; "type": "sub", "topic": "space", "id": "&lt;spaceId&gt;" &#125;
&#123; "type": "sub", "topic": "room", "id": "&lt;roomId&gt;" &#125;
&#123; "type": "sub", "topic": "stream", "id": "&lt;streamDid&gt;", "cursor": 1234 &#125;

// Unsubscribe from a topic
&#123; "type": "unsub", "topic": "room", "id": "&lt;roomId&gt;" &#125;

// Reconnection cursor (protocol-level; server responds with a full invalidation)
&#123; "type": "cursor", "seq": 12345 &#125;</code></pre>

  <h3>Topic Semantics</h3>
  <table>
    <thead>
      <tr>
        <th>Topic</th>
        <th>Content</th>
      </tr>
    </thead>
    <tbody>
      <tr><td><code>space:&lt;id&gt;</code></td><td>Sidebar/metadata changes, membership changes, thread creation</td></tr>
      <tr><td><code>room:&lt;id&gt;</code></td><td>Message diffs, room metadata changes, unread-count deltas</td></tr>
      <tr><td><code>stream:&lt;id&gt;</code></td><td>Raw event stream — cursor-based backfill, then live events (<code>#streamEvents</code>)</td></tr>
    </tbody>
  </table>

  <p>Subscribing to a space does <strong>not</strong> automatically subscribe to all rooms in it. Room subscriptions are explicit. The SDK's <code>TopicManager</code> reference-counts topics so multiple components sharing a topic send only one <code>sub</code>.</p>

  <h2>Server &rarr; Client Messages</h2>

  <p>CBOR-encoded binary frames using the ATProto wire format (two consecutive CBOR values: header + body).</p>

  <table>
    <thead>
      <tr>
        <th><code>t</code> (event type)</th>
        <th><code>op</code></th>
        <th>Purpose</th>
      </tr>
    </thead>
    <tbody>
      <tr><td><code>#messageDiff</code></td><td>1</td><td>Message add/update/remove for a subscribed room</td></tr>
      <tr><td><code>#roomMetadataDiff</code></td><td>1</td><td>Unread-count delta for a room, per affected user</td></tr>
      <tr><td><code>#invalidate</code></td><td>1</td><td>Signal that a query's data is stale</td></tr>
      <tr><td><code>#streamEvents</code></td><td>1</td><td>Batch of raw stream events (backfill or live) for a stream subscription</td></tr>
      <tr><td><code>#error</code></td><td>-1</td><td>Error frame (closes connection)</td></tr>
    </tbody>
  </table>

  <h3>#messageDiff</h3>

  <p>Applied directly to the TanStack Query cache via <code>setQueryData()</code>. No HTTP round-trip. Each diff carries a <code>seq</code> from a single global, monotonically increasing counter (shared with <code>#roomMetadataDiff</code>); the client detects missed frames via seq gaps and forces a refetch of the active room.</p>

  <pre><code>// Header: &#123; op: 1, t: "#messageDiff" &#125;
// Body:
&#123;
  roomId: string;
  seq: number;
  ops: Array&lt;&#123;
    op: "add" | "update" | "remove";
    key: string;          // message entity ID
    message?: &#123;           // present for add/update, absent for remove
      id: string;
      sort_idx?: string;
      content: string;
      authorDid: string;
      authorName: string;
      authorHandle?: string;
      authorAvatar?: string;
      timestamp: string;
      replyTo?: string;
      forwardedFrom?: &#123;
        messageId: string;
        name: string;
        roomId: string;
        message?: Message; // fully denormalised original (nested forwards chain)
      &#125;;
      reactions: Array&lt;&#123; emoji: string; count: number; myReactionId?: string &#125;&gt;;
      media: Array&lt;&#123; url: string; type: string; alt?: string; width?: number; height?: number; blurhash?: string; size?: number; length?: number; name?: string &#125;&gt;;
      linkEmbeds: Array&lt;&#123; url: string; embed?: object &#125;&gt;;
    &#125;;
  &#125;&gt;;
&#125;</code></pre>

  <h3>#roomMetadataDiff</h3>

  <p>Unread-count delta for a room, sent <strong>per affected user</strong> (not broadcast — only users with a read-position row for the room get a frame; a user with multiple tabs gets one per connection). The client patches three cache entries without refetching: <code>room.getMetadata.unreadCount</code>, the matching <code>SpaceRow.unreadCount</code> in <code>getSpaces</code>, and the channel entry in the <code>space.getMetadata</code> sidebar tree.</p>

  <pre><code>// Header: &#123; op: 1, t: "#roomMetadataDiff" &#125;
// Body:
&#123;
  spaceId: string;
  roomId: string;
  delta: number;   // +1 per message
  seq: number;
&#125;</code></pre>

  <h3>#invalidate</h3>

  <p>Triggers <code>invalidateQueries()</code> for the specified endpoint.</p>

  <pre><code>// Header: &#123; op: 1, t: "#invalidate" &#125;
// Body:
&#123;
  nsid: string;                      // e.g. "space.roomy.space.getMetadata"
  params: Record&lt;string, string&gt;;    // e.g. &#123; spaceId: "..." &#125;
&#125;</code></pre>

  <p>The client maps this directly to:</p>
  <pre><code>queryClient.invalidateQueries(&#123; queryKey: [nsid, params] &#125;);</code></pre>

  <p><code>getSpaces</code> and <code>getActivityFeed</code> are user-scoped global queries — invalidation for them is broadcast to <strong>all</strong> of the affected user's connections regardless of topic subscriptions (the user may be on a page with no space topic). Signals carrying an <code>affectedUser</code> (e.g. admin-edge changes, role assignments, join/leave) are delivered only to that user's connections.</p>

  <h3>#streamEvents</h3>

  <p>Delivered to <code>stream:&lt;did&gt;</code> subscriptions. On subscribe the server backfills from the given cursor (exclusive, in batches of 100), then streams live events. <code>hasMore</code> is true while backfill batches are still following; live events arriving during backfill are picked up by the next backfill batch so cursor ordering is preserved.</p>

  <pre><code>// Header: &#123; op: 1, t: "#streamEvents" &#125;
// Body:
&#123;
  streamDid: string;
  cursor: number;            // last delivered idx
  hasMore: boolean;
  events: Array&lt;&#123;
    idx: number;
    user: string;
    payload: object;         // decoded event
  &#125;&gt;;
&#125;</code></pre>

  <h3>#error</h3>

  <pre><code>// Header: &#123; op: -1, t: "#error" &#125;
// Body:
&#123;
  error: string;     // e.g. "TokenExpired", "InternalServerError"
  message: string;
&#125;</code></pre>

  <h2>Reconnection</h2>

  <p>The SDK's <code>SyncConnection</code> handles reconnection automatically:</p>

  <ol>
    <li>On abnormal close, reconnect after an exponentially increasing delay with full jitter (1s base, 30s max); the counter resets on a successful open</li>
    <li>Each connect attempt mints a <strong>fresh ticket</strong> (tickets are single-use)</li>
    <li>On open, all in-memory topics are re-sent automatically</li>
    <li>Subscribing to a room topic immediately invalidates <code>room.getMetadata</code>, <code>room.getMessages</code>, and <code>room.getThreads</code>, so the client re-fetches anything missed while disconnected</li>
    <li>The client additionally watches for <code>seq</code> gaps (or a seq reset after an appserver restart) and refetches the visible room</li>
  </ol>

  <p>Cursor-based replay of missed diffs is a future concern. For now, reconnection always means HTTP re-fetch — there is no persistence of diffs across appserver restarts.</p>

  <h2>Event &rarr; Frame Mapping</h2>

  <p>Derived from <code>src/invalidation/inferSignals.ts</code> — the single source of truth for "what changed when event X fires".</p>

  <table>
    <thead>
      <tr>
        <th>Event</th>
        <th>Affected topic(s)</th>
        <th>Server action</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>createMessage in room X</td><td><code>room:X</code></td><td><code>#messageDiff</code> (add) + <code>#roomMetadataDiff</code> (delta +1) + <code>#invalidate</code> room.getMetadata, room.getThreads, space.getMetadata (author)</td></tr>
      <tr><td>editMessage in room X</td><td><code>room:X</code></td><td><code>#messageDiff</code> (update) + <code>#invalidate</code> room.getMetadata</td></tr>
      <tr><td>deleteMessage in room X</td><td><code>room:X</code></td><td><code>#messageDiff</code> (remove)</td></tr>
      <tr><td>forwardMessages into room X</td><td><code>room:X</code></td><td><code>#messageDiff</code> (add) + <code>#roomMetadataDiff</code> (delta +1)</td></tr>
      <tr><td>Reaction add/remove in room X</td><td><code>room:X</code></td><td><code>#invalidate</code> room.getMessages + activity feed (+ message.getMessage)</td></tr>
      <tr><td>createRoom in space Y</td><td><code>space:Y</code>, <code>room:&lt;new&gt;</code></td><td><code>#invalidate</code> space.getMetadata, getSpaces, getThreads, getMembers + room.getMetadata, getMessages, getThreads</td></tr>
      <tr><td>updateRoom / deleteRoom / restoreRoom</td><td><code>space:&lt;parent&gt;</code>, <code>room:X</code></td><td><code>#invalidate</code> room.getMetadata + space queries</td></tr>
      <tr><td>Space info / sidebar config change</td><td><code>space:X</code></td><td><code>#invalidate</code> space.getMetadata (+ getSpaces)</td></tr>
      <tr><td>joinSpace / leaveSpace in space X</td><td><code>space:X</code></td><td><code>#invalidate</code> getSpaces, getMetadata, getThreads, getMembers (affectedUser = caller)</td></tr>
      <tr><td>Admin edge add/remove</td><td><code>space:X</code></td><td><code>#invalidate</code> getSpaces, getMetadata, getMembers</td></tr>
      <tr><td>Role create/update/delete</td><td><code>space:Y</code></td><td><code>#invalidate</code> space.getRoles</td></tr>
      <tr><td>addMemberRole / removeMemberRole</td><td><code>space:Y</code></td><td><code>#invalidate</code> getRoles, getMembers (affectedUser)</td></tr>
      <tr><td>createInvite / revokeInvite</td><td><code>space:Y</code></td><td><code>#invalidate</code> space.getInvites</td></tr>
    </tbody>
  </table>

  <h2>Server-side Pub/Sub</h2>

  <p>The appserver's <code>SyncManager</code> maintains an in-memory routing table:</p>

  <pre><code>connection_id &rarr; &#123; did, Set&lt;topic&gt; &#125;    // identity + topics this WS connection is subscribed to
topic          &rarr; Set&lt;connection_id&gt;     // which connections care about this topic</code></pre>

  <p>When an event is materialised:</p>
  <ol>
    <li>The <code>InvalidationRouter</code> infers signals (message diff, room metadata diff, query invalidation)</li>
    <li>The <code>SyncManager</code> maps each signal to its topics (e.g. message in room X &rarr; topic <code>room:X</code>)</li>
    <li>Frames are generated and sent to the matching connections, filtered by <code>affectedUser</code> where present</li>
  </ol>

  <p>Memory cost is bounded by: <code>(active connections) &times; (avg subscriptions per connection)</code>. Typical session: 1 space + 1 room = 2 topics.</p>

  <p><strong>Per-user invalidation.</strong> Some invalidations (admin edge changes, role assignment changes, join/leave) only affect a specific user. The connection's authenticated <code>did</code> is recorded at WS handshake time (from the ticket); routing for these events filters by <code>did</code>.</p>
</div>
