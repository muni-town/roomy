# XRPC Interface Specification

**Date:** 2026-04-13
**Status:** Spec
**Parent doc:** `appserver-architecture.md`

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| WebSocket model | Single multiplexed connection | Browser WS limit (~6 per domain) makes per-procedure subscriptions unviable |
| Client cache | TanStack Query (not TanStack DB) | Server sends denormalized results; IVM adds no value. TanStack Query is production-grade, runes-compatible, supports `invalidateQueries()` and `setQueryData()` |
| Join ownership | Server-side | Appserver owns all SQL joins. Client never joins data. API returns fully assembled objects. |
| Data freshness | WS is sole freshness authority | All queries use `staleTime: Infinity`. HTTP re-fetches only on WS invalidation signals. |
| WS message categories | Message diffs + invalidation signals | Diffs applied via `setQueryData()` (hot path, no HTTP round-trip). Invalidation signals trigger `invalidateQueries()` → HTTP re-fetch. |
| Endpoint granularity | Broad queries over narrow | Space metadata includes sidebar tree. Room metadata includes recent threads. Fewer round-trips, less client-side merging. |

### Frontend Data Flow Changes

Merging sidebar into `space.getMetadata` and linked rooms into `room.getMetadata` changes how the client consumes this data:

- **Before (LiveQuery):** `#metadataQuery` and `#sidebarQuery` were separate reactive queries in `SpaceState`, merged client-side.
- **After:** Single `space.roomy.space.getMetadata` query returns everything. The `SpaceState` layer is replaced by a single TanStack Query whose result is consumed directly by the sidebar component.
- **Room page:** Instead of a separate `LinkedRoomsList` query, the room metadata query includes `recentThreads`. The linked rooms panel reads from the same query cache.

---

## Endpoint Summary

### HTTP Queries (GET, authenticated via PDS proxy)

| NSID | Source LiveQuery | Description |
|------|-----------------|-------------|
| `space.roomy.space.getSpaces` | #1 | All joined spaces with metadata and permissions |
| `space.roomy.space.getMetadata` | #2, #3, #4 | Space name, avatar, description **+ complete sidebar tree** |
| `space.roomy.space.getThreads` | #7 | Threads for space board/index view |
| `space.roomy.room.getMetadata` | #6, #8, #10 | Room name, kind, spaceId, lastRead, unreadCount **+ recent threads** |
| `space.roomy.room.getMessages` | #5 | Paginated messages for a room |
| `space.roomy.room.getThreads` | #11 | All threads within a channel |
| `space.roomy.message.getMessage` | #14 | Single message by ID |

### HTTP Procedures (POST, authenticated via PDS proxy)

| NSID | Description |
|------|-------------|
| `space.roomy.auth.getConnectionTicket` | Obtain WS pre-auth ticket |

### WebSocket Subscription (single connection)

| NSID | Description |
|------|-------------|
| `space.roomy.sync.subscribe` | Multiplexed real-time sync: message diffs + invalidation signals |

**Total: 7 queries, 1 procedure, 1 subscription = 9 XRPC methods.**

Eliminated from initial scope:
- `space.roomy.space.getSidebar` — merged into `getMetadata`
- `space.roomy.room.getLinkedRooms` — merged into `room.getMetadata` as `recentThreads`
- `space.roomy.page.getContent` / `space.roomy.page.getHistory` — page features disabled in client
- `space.roomy.space.getCalendarLink` / `space.roomy.space.getCalendarEvents` — low priority
- EntityName inline query (#9) — parent queries include names directly

---

## HTTP Query Endpoints

All HTTP queries are authenticated via PDS proxy with inter-service JWT (see `authentication.md`).

### `space.roomy.space.getSpaces`

Returns all spaces the caller is a member of, with metadata and per-space permissions.

**Params:** *(none)*

**Response:**

```typescript
{
  spaces: Array<{
    id: string;
    name: string | null;
    avatar: string | null;
    description: string | null;
    permissions: {
      can: Array<string>;  // e.g. ["createRoom", "sendMessage", "manageSpace"]
    };
  }>;
}
```

**Invalidation signals:** `#spaceState` with `"membership"` when user joins/leaves a space.

---

### `space.roomy.space.getMetadata`

Returns space metadata **and the complete sidebar tree** in a single response. The server handles orphan detection (channels not pinned to any category) that was previously done client-side.

**Params:** `spaceId` (required)

**Response:**

```typescript
{
  name: string | null;
  avatar: string | null;
  description: string | null;
  sidebar: {
    categories: Array<{
      id: string;           // category entity ID
      name: string;
      position: number;
      channels: Array<{
        id: string;         // channel entity ID
        name: string;
        unreadCount: number;
        lastRead: string | null;  // ISO timestamp
      }>;
    }>;
    orphans: Array<{        // channels not in any category
      id: string;
      name: string;
      unreadCount: number;
      lastRead: string | null;
    }>;
  };
}
```

**Invalidation signals:** `#invalidate` targeting this endpoint on sidebar config changes, channel creation, message activity (unread count changes), space name/avatar changes.

**Frontend note:** This replaces the separate `#metadataQuery` and `#sidebarQuery` in `SpaceState`. The sidebar component reads `data.sidebar` directly from this query's result.

---

### `space.roomy.space.getThreads`

Returns all threads in a space for the board/index view, with latest activity metadata.

**Params:** `spaceId` (required)

**Response:**

```typescript
{
  threads: Array<{
    id: string;
    name: string;
    channel: string | null;     // parent channel ID
    activity: {
      latestTimestamp: string;   // ISO timestamp of latest message
      latestMembers: Array<{    // up to 3 unique recent participants
        did: string;
        name: string;
        avatar: string | null;
      }>;
    };
  }>;
}
```

---

### `space.roomy.room.getMetadata`

Returns room metadata **with recently active threads** included. The `recentThreads` field replaces the separate `getLinkedRooms` query — it provides enough data for the linked rooms panel in the room view.

**Params:** `roomId` (required)

**Response:**

```typescript
{
  name: string;
  kind: string;              // "channel" | "thread"
  spaceId: string;
  lastRead: string | null;   // ISO timestamp
  unreadCount: number;
  recentThreads: Array<{     // recently active threads (linked or child threads)
    id: string;
    name: string;
    unreadCount: number;
    lastRead: string | null;
  }>;
}
```

**Invalidation signals:** `#invalidate` targeting this endpoint on room name changes, unread count changes, thread activity.

**Frontend note:** The `LinkedRoomsList` component reads `data.recentThreads` instead of issuing a separate query. For the full thread list in a channel, use `space.roomy.room.getThreads`.

---

### `space.roomy.room.getMessages`

Paginated message history for a room. Returns fully denormalized message objects with all joins resolved server-side. This is the most complex query (source LiveQuery #5 joins 10+ tables).

**Params:**
- `roomId` (required)
- `limit` (optional, default 50, max 100)
- `cursor` (optional) — message entity ID for cursor-based pagination (messages older than this ID)

**Response:**

```typescript
{
  messages: Array<{
    id: string;
    content: string;
    authorDid: string;
    authorName: string;
    authorAvatar: string | null;
    timestamp: string;           // ISO timestamp
    replyTo: string | null;      // parent message ID
    forwardedFrom: {
      name: string;
      roomId: string;
    } | null;
    reactions: Array<{
      emoji: string;
      dids: string[];            // DIDs of users who reacted
    }>;
    media: Array<{
      url: string;
      type: string;              // MIME type
      alt: string | null;
    }>;
    tags: string[];
  }>;
  cursor: string | null;         // next page cursor, null if no more
}
```

- Cursor is a message entity ID, not a timestamp, to handle concurrent messages correctly.
- Includes forwarded messages (follows `forward` edge to get original content).

---

### `space.roomy.room.getThreads`

All threads within a specific channel.

**Params:** `roomId` (required)

**Response:**

```typescript
{
  threads: Array<{
    id: string;
    name: string;
    canonicalParent: string | null;
    activity: {
      latestTimestamp: string;
      latestMembers: Array<{
        did: string;
        name: string;
        avatar: string | null;
      }>;
    };
  }>;
}
```

---

### `space.roomy.message.getMessage`

Single message by ID.

**Params:** `messageId` (required)

**Response:** Same shape as a single message object from `space.roomy.room.getMessages`.

```typescript
{
  id: string;
  content: string;
  authorDid: string;
  authorName: string;
  authorAvatar: string | null;
  timestamp: string;
  replyTo: string | null;
  forwardedFrom: { name: string; roomId: string } | null;
  reactions: Array<{ emoji: string; dids: string[] }>;
  media: Array<{ url: string; type: string; alt: string | null }>;
  tags: string[];
}
```

**Cache optimisation:** TanStack Query caches are isolated per queryKey — no automatic cross-query cache sharing. Use `initialData` to check the room messages cache first:

```typescript
function createMessageQuery(messageId: string, roomId: string) {
  return createQuery({
    queryKey: ["space.roomy.message.getMessage", { messageId }],
    queryFn: async () => {
      const res = await fetchViaPds(
        `/xrpc/space.roomy.message.getMessage?messageId=${messageId}`,
      );
      return res.json();
    },
    initialData: () => {
      const roomMessages = queryClient.getQueryData(
        ["space.roomy.room.getMessages", { roomId }],
      );
      return roomMessages?.find((m) => m.id === messageId);
    },
  });
}
```

If the message is in the room cache, `initialData` resolves immediately with no network request. If not found, the `queryFn` fetches from the server. The caller must pass `roomId` for cache lookup — always available for reply previews in ChatArea; falls back to network for other contexts.

---

## WebSocket Subscription: `space.roomy.sync.subscribe`

### Overview

A single multiplexed WebSocket connection carries all real-time data. The client subscribes/unsubscribes to topics; the server pushes two categories of messages:

1. **Message diffs** (`#messageDiff`) — applied directly to TanStack Query cache via `setQueryData()`. No HTTP round-trip.
2. **Invalidation signals** (`#invalidate`, `#spaceState`) — trigger `invalidateQueries()` → HTTP re-fetch.

### Connection Lifecycle

```text
1. Client obtains ticket via POST /xrpc/space.roomy.auth.getConnectionTicket
2. Client opens WebSocket:
   wss://appserver.roomy.chat/xrpc/space.roomy.sync.subscribe?ticket=<ticket>
3. Server validates ticket, accepts connection
4. Client sends { "type": "cursor", "seq": N } if reconnecting
5. Client sends sub messages for active topics
6. Server pushes frames for subscribed topics
7. On disconnect: client reconnects with new ticket + last received seq
```

### Client → Server Messages

JSON-encoded text frames:

```typescript
// Subscribe to a topic
{ "type": "sub", "topic": "space", "id": "<spaceId>" }
{ "type": "sub", "topic": "room", "id": "<roomId>" }

// Unsubscribe from a topic
{ "type": "unsub", "topic": "room", "id": "<roomId>" }

// Reconnection cursor (sent once, immediately after connect)
{ "type": "cursor", "seq": 12345 }
```

Topic semantics:
- `space:<id>` — sidebar/metadata changes, membership changes, thread creation
- `room:<id>` — message diffs, room metadata changes, reaction changes, thread activity

Subscribing to a space does **not** automatically subscribe to all rooms in it. Room subscriptions are explicit (the client subscribes to the active room).

### Server → Client Messages

CBOR-encoded binary frames using ATProto wire format (two consecutive CBOR values: header + body).

| `t` (event type) | `op` | Purpose |
| --- | --- | --- |
| `#messageDiff` | 1 | Message add/update/remove for a subscribed room |
| `#invalidate` | 1 | Signal that a query's data is stale |
| `#spaceState` | 1 | Atomic batch of invalidations for a space |
| `#error` | -1 | Error frame (closes connection) |

#### `#messageDiff`

Applied directly to TanStack Query cache. No HTTP round-trip.

```typescript
// Header: { op: 1, t: "#messageDiff" }
// Body:
{
  roomId: string;
  seq: number;
  ops: Array<{
    op: "add" | "update" | "remove";
    key: string;          // message entity ID
    message?: {           // present for add/update, absent for remove
      id: string;
      content: string;
      authorDid: string;
      authorName: string;
      authorAvatar: string | null;
      timestamp: string;
      replyTo: string | null;
      forwardedFrom: { name: string; roomId: string } | null;
      reactions: Array<{ emoji: string; dids: string[] }>;
      media: Array<{ url: string; type: string; alt: string | null }>;
      tags: string[];
    };
  }>;
}
```

#### `#invalidate`

Triggers `invalidateQueries()` for the specified endpoint.

```typescript
// Header: { op: 1, t: "#invalidate" }
// Body:
{
  nsid: string;                      // e.g. "space.roomy.space.getMetadata"
  params: Record<string, string>;    // e.g. { spaceId: "..." }
}
```

The client maps this directly to:

```typescript
queryClient.invalidateQueries({ queryKey: [nsid, params] });
```

#### `#spaceState`

Atomic batch of invalidations for a space-level change. Useful for events that affect multiple queries simultaneously (e.g. a new thread invalidates both metadata/sidebar and the thread list).

```typescript
// Header: { op: 1, t: "#spaceState" }
// Body:
{
  spaceId: string;
  changes: Array<"metadata" | "membership" | "threads">;
  seq: number;
}
```

The client expands this into targeted invalidations:

```typescript
for (const change of body.changes) {
  if (change === "metadata" || change === "membership") {
    // metadata includes sidebar, so this covers sidebar changes too
    queryClient.invalidateQueries({
      queryKey: ["space.roomy.space.getMetadata", { spaceId }],
    });
  }
  if (change === "membership" || change === "threads") {
    queryClient.invalidateQueries({
      queryKey: ["space.roomy.space.getThreads", { spaceId }],
    });
  }
}
```

#### `#error`

```typescript
// Header: { op: -1, t: "#error" }
// Body:
{
  error: string;     // e.g. "TokenExpired", "InternalServerError"
  message: string;
}
```

### Reconnection

1. Client sends `{ "type": "cursor", "seq": N }` immediately after connecting
2. Server replays missed `#messageDiff` frames from its SQLite event log (by seq number)
3. Server sends broad `#invalidate` signals for any queries that may have changed during disconnection (conservative: invalidate broadly rather than risk stale data)
4. If cursor is too old (server has pruned events), server invalidates all subscribed queries

The sequence number is per-user, assigned by the appserver when writing events to its SQLite materialised views. It is not the Leaf stream sequence.

---

## Invalidation Signal Routing

### Event → Frame Mapping

| Leaf event | Affected topic(s) | Server action |
| --- | --- | --- |
| New message in room X | `room:X` | `#messageDiff` (add) to all connections subscribed to `room:X` |
| Message edit in room X | `room:X` | `#messageDiff` (update) |
| Message delete in room X | `room:X` | `#messageDiff` (remove) |
| Reaction add/remove in room X | `room:X` | `#messageDiff` (update — reaction field changed) |
| Room name/kind change | `space:<parentSpace>` | `#invalidate` for `space.roomy.room.getMetadata` |
| New thread in channel X (space Y) | `space:Y`, `room:X` | `#spaceState` with `["metadata", "threads"]` + `#invalidate` for room metadata |
| Space name/avatar/description change | `space:X` | `#invalidate` for `space.roomy.space.getMetadata` |
| Sidebar config change | `space:X` | `#invalidate` for `space.roomy.space.getMetadata` (sidebar is part of this response) |
| User join/leave space X | `space:X` | `#spaceState` with `["membership"]` |
| Unread count change | `room:X`, `space:<parent>` | `#invalidate` for `space.roomy.room.getMetadata` and `space.roomy.space.getMetadata` |
| Thread activity in room X | `room:X` | `#invalidate` for `space.roomy.room.getMetadata` (recentThreads) |

### Server-side Pub/Sub

The appserver maintains an in-memory routing table:

```text
connection_id → Set<topic>        // what this WS connection is subscribed to
topic          → Set<connection_id> // which connections care about this topic
```

When a Leaf event arrives:
1. Determine affected topics (e.g. message in room X → topic `room:X`)
2. Look up subscribed connections for that topic
3. Generate frame(s) and send to matching connections

Memory cost is bounded by: `(active connections) × (avg subscriptions per connection)`. Typical session: 1 space + 1 room = 2 topics.

---

## Client Integration with TanStack Query

### Query Client Setup

```typescript
import { QueryClient } from "@tanstack/svelte-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,            // WS is sole freshness authority
      refetchOnWindowFocus: false,    // no automatic refetching
      refetchOnReconnect: false,      // WS handles reconnection data
    },
  },
});
```

### Query Key Convention

Every query uses `[nsid, params]` as its key. This maps directly to the `#invalidate` frame format.

```typescript
["space.roomy.space.getMetadata", { spaceId: "..." }]
["space.roomy.room.getMessages", { roomId: "..." }]
["space.roomy.room.getMetadata", { roomId: "..." }]
```

### Query Definitions

```typescript
import { createQuery } from "@tanstack/svelte-query";

function createSpaceMetadataQuery(spaceId: string) {
  return createQuery({
    queryKey: ["space.roomy.space.getMetadata", { spaceId }],
    queryFn: async ({ queryKey: [, params] }) => {
      const url = `/xrpc/space.roomy.space.getMetadata?spaceId=${params.spaceId}`;
      const res = await fetchViaPds(url);
      return res.json();
    },
  });
}

function createRoomMetadataQuery(roomId: string) {
  return createQuery({
    queryKey: ["space.roomy.room.getMetadata", { roomId }],
    queryFn: async ({ queryKey: [, params] }) => {
      const url = `/xrpc/space.roomy.room.getMetadata?roomId=${params.roomId}`;
      const res = await fetchViaPds(url);
      return res.json();
    },
  });
}

function createMessagesQuery(roomId: string) {
  return createQuery({
    queryKey: ["space.roomy.room.getMessages", { roomId }],
    queryFn: async ({ queryKey: [, params] }) => {
      const url = `/xrpc/space.roomy.room.getMessages?roomId=${params.roomId}&limit=50`;
      const res = await fetchViaPds(url);
      const data = await res.json();
      return data.messages;
    },
  });
}
```

### WS Message Handler

```typescript
ws.onmessage = (event) => {
  const { header, body } = decodeCborFrame(event.data);

  switch (header.t) {
    case "#messageDiff": {
      queryClient.setQueryData(
        ["space.roomy.room.getMessages", { roomId: body.roomId }],
        (oldMessages = []) => applyMessageDiff(oldMessages, body.ops),
      );
      break;
    }

    case "#invalidate": {
      queryClient.invalidateQueries({
        queryKey: [body.nsid, body.params],
      });
      break;
    }

    case "#spaceState": {
      const { spaceId, changes } = body;
      for (const change of changes) {
        if (change === "metadata" || change === "membership") {
          queryClient.invalidateQueries({
            queryKey: ["space.roomy.space.getMetadata", { spaceId }],
          });
        }
        if (change === "membership" || change === "threads") {
          queryClient.invalidateQueries({
            queryKey: ["space.roomy.space.getThreads", { spaceId }],
          });
        }
      }
      break;
    }
  }
};
```

### Diff Application

```typescript
function applyMessageDiff(
  messages: Message[],
  ops: DiffOp[],
): Message[] {
  const map = new Map(messages.map((m) => [m.id, m]));
  for (const op of ops) {
    if (op.op === "add" && op.message) {
      map.set(op.key, op.message);
    } else if (op.op === "update" && op.message) {
      map.set(op.key, { ...map.get(op.key), ...op.message });
    } else if (op.op === "remove") {
      map.delete(op.key);
    }
  }
  return [...map.values()].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}
```

---

## Lexicons

```text
lexicons/
  space/
    roomy/
      auth/
        getConnectionTicket.json   ← already exists
      space/
        getSpaces.json
        getMetadata.json
        getThreads.json
      room/
        getMetadata.json
        getMessages.json
        getThreads.json
      message/
        getMessage.json
      sync/
        subscribe.json
```

Lexicons follow ATProto JSON schema format. The `space.roomy.sync.subscribe` lexicon defines the subscription NSID but does not prescribe individual message types — those are appserver-internal protocol details documented here.

---

## Relationship to Existing Documents

| Document | Relationship |
| --- | --- |
| `appserver-architecture.md` | Master architecture. This spec is a child document defining the API contract. |
| `xrpc-layer-plan.md` | Implementation plan for the routing layer that serves these endpoints. |
| `auth-design.md` | Auth design for all endpoints (PDS proxy + ticket). |
| `authentication.md` | Auth implementation reference. |
| `livequery-inventory.md` | Source mapping of all 16 LiveQuery instances to these endpoints. |
