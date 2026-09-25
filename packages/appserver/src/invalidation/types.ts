/**
 * Types for the invalidation system.
 *
 * An InvalidationSignal is emitted whenever an event changes data that
 * one or more XRPC query endpoints depend on. Signals are consumed by:
 *
 *   1. The WS sync handler → #invalidate / #messageDiff frames to clients
 *   2. The server-side response cache → evict stale entries
 *   3. (future) Notification router → push alerts
 *
 * The mapping from event → signals is pure and stateless (lives in
 * `inferSignals`). The `InvalidationRouter` wraps it in a typed pub/sub bus.
 */

import type { EventType, StreamDid, UserDid, Ulid } from "@roomy-space/sdk";
import type { MessageDto } from "../queries/selectMessages.ts";
import type { DbLike } from "../db/types.ts";

// ─── NSIDs for XRPC query endpoints ─────────────────────────────────────

/** The set of XRPC query NSIDs that the invalidation system can target. */
export type QueryNsid =
  | "space.roomy.space.getSpaces"
  | "space.roomy.space.getMetadata"
  | "space.roomy.space.getThreads"
  | "space.roomy.space.getLinks"
  | "space.roomy.space.getRoles"
  | "space.roomy.space.getMembers"
  | "space.roomy.space.getInvites"
  | "space.roomy.space.getActivityFeed"
  | "space.roomy.room.getMetadata"
  | "space.roomy.room.getMessages"
  | "space.roomy.room.getThreads"
  | "space.roomy.room.getLinks"
  | "space.roomy.message.getMessage"
  | "space.roomy.federation.getRequests"
  | "space.roomy.federation.getIncoming"
  | "space.roomy.federation.getOutgoing"
  | "space.roomy.federation.getGrants"
  | "space.roomy.sync.getEvents"

// ─── Signals ────────────────────────────────────────────────────────────

/** A query endpoint whose cached data is now stale. */
export interface QueryInvalidation {
  /** The NSID of the affected query. */
  nsid: QueryNsid;
  /** Query params that identify the stale cache entry. */
  params: Readonly<Record<string, string>>;
  /**
   * If set, this invalidation only matters for a specific user's cache.
   * Used for caller-scoped fields (isAdmin, canRead, sidebar visibility).
   * WS handler uses this to filter which connections receive the frame.
   * Server cache uses this to evict only per-user entries.
   */
  affectedUser?: UserDid;
  /**
   * Evict the server-side response cache WITHOUT sending a `#invalidate`
   * frame to connected clients.
   *
   * The two consumers want different things. The server cache must be evicted
   * on every change (a client loading the page fresh has no diff frame to
   * apply — it would otherwise be served a stale body for up to the cache
   * TTL). A connected client, however, is already patchable from a diff frame,
   * so an invalidation frame for it is pure refetch cost.
   *
   * Emit this for queries whose client-side freshness is delivered by a diff
   * (see `RoomActivityDiff`) but whose *cached* response body is still stale —
   * `space.getThreads` and `room.getMetadata` on `createMessage`, whose
   * board/`recentThreads` ordering is patched client-side by the activity
   * diff while the server cache still needs the eviction.
   */
  cacheEvictionOnly?: boolean;
}

/** A message-level add/update/remove within a room. */
export interface MessageDiff {
  roomId: Ulid;
  /** Monotonically increasing sequence number for cursor replay. */
  seq: number;
  ops: MessageDiffOp[];
}

export type MessageDiffOp =
  | { op: "add"; key: Ulid; message: MessageSnapshot; kind?: "mention" | "reply" }
  | { op: "update"; key: Ulid; message: MessageSnapshot; kind?: "mention" | "reply" }
  | { op: "remove"; key: Ulid };

/**
 * Full message object carried by a `#messageDiff` `add`/`update` op.
 *
 * Identical to a `room.getMessages` row (`MessageDto`) so the client can
 * apply it to the query cache without re-fetching. It MUST stay a complete
 * `MessageDto` — the client validates the frame against the SDK `Message`
 * schema and silently drops the frame if any required field is missing.
 */
export type MessageSnapshot = MessageDto;

/**
 * Unread-count delta for a room, emitted when a message is created.
 * Unlike `MessageDiff` (broadcast to the room topic), this signal is
 * per-user: the SyncManager sends a `#roomMetadataDiff` frame to each
 * affected user's connection.
 *
 * The frame carries a `delta` (the increment, `+1` per message) rather
 * than the absolute unread count — the client applies `prev + delta` to
 * each cache entry, so the server never needs to read the absolute count
 * or know the previous value.
 *
 * The frame carries the exact change the client needs, so the broad
 * `getSpaces` + `space.getMetadata` invalidation is not required: the client
 * patches `room.getMetadata.unreadCount`, the matching `SpaceRow.unreadCount`
 * in `getSpaces`, and the channel's `unreadCount` in the `space.getMetadata`
 * sidebar tree directly from the frame, with no refetch.
 */
export interface RoomMetadataDiff {
  spaceId: StreamDid;
  roomId: Ulid;
  /** Monotonically increasing sequence number for cursor replay. */
  seq: number;
  /**
   * The unread-count increment (always `+1` per createMessage event). The
   * client adds this to the cached `unreadCount` of each patched entry.
   */
  delta: number;
  /**
   * The users with a `read_positions` row for this room — exactly the set
   * the materializer's unread-count bump touched. The SyncManager sends
   * one `#roomMetadataDiff` frame per user in this list.
   */
  users: ReadonlyArray<UserDid>;
  /**
   * The thread's parent channel id (thread messages only). The client uses
   * it to patch the parent channel's `unreadThreadCount` in
   * `room.getMetadata` and the matching active-thread entry in the sidebar.
   */
  parentChannelId?: string;
  /**
   * Per-user room-count deltas: `+1` for each user whose channel became
   * newly-unread (their `unread_count` went 0 → 1). Keyed by user DID; the
   * SyncManager picks each user's delta when building its frame.
   */
  roomUnreadDeltas?: ReadonlyMap<UserDid, number>;
  /**
   * Per-user room-count deltas for engaged threads: `+1` for each user
   * whose engaged thread became newly-unread. Keyed by user DID.
   */
  threadUnreadDeltas?: ReadonlyMap<UserDid, number>;
}


/**
 * A message that mentions a user, routed to connections subscribed to the
 * `mentions:<did>` sync topic. Emitted from `inferSignals` when a message
 * create/edit/delete changes who a message mentions.
 *
 * The `did` is the mentioned user (the stable ID — never the handle or
 * display name). The author's own DID is excluded (self-mentions don't
 * notify the author).
 */
export interface MentionDiff {
  /** The mentioned user's DID. */
  did: UserDid;
  spaceId: StreamDid;
  roomId: Ulid;
  /** Monotonically increasing sequence number for cursor replay. */
  seq: number;
  /** Reuse the message snapshot shape from MessageDiff. */
  ops: MessageDiffOp[];
}

/**
 * A room's latest-activity facts, broadcast when a message lands in it.
 *
 * This is what keeps the activity-ordered *board* views (`space.getThreads`,
 * `room.getThreads`) and `room.getMetadata.recentThreads` ordered and
 * up to date without refetching them on every message: the client upserts the
 * row it describes and moves it to the front of its board.
 *
 * It is deliberately a **broadcast** (one frame to every subscriber of the
 * room / its parent channel / the space), unlike `RoomMetadataDiff`, which is
 * caller-scoped and therefore sent once per affected user. Folding these
 * structural, identical-for-everyone fields into that per-user frame would put
 * a copy of the board row on the wire once per reader.
 *
 * It carries no caller-scoped field: `unreadCount` / `unread` stay with
 * `RoomMetadataDiff` (which knows the delta) and `unreadThreadCount` with its
 * channel patch.
 */
export interface RoomActivityDiff {
  spaceId: StreamDid;
  roomId: Ulid;
  /** Room kind — the board renders channels and threads differently. */
  kind: "thread" | "channel";
  name?: string;
  /** Parent channel (threads only) — the client patches that channel's boards. */
  parentChannelId?: string;
  parentChannelName?: string;
  activity: RoomActivityDiffActivity;
}

/**
 * The changed halves of a board row's `activity` object.
 *
 * `latestMembers` carries only the participants *this message* added (the
 * author). The server's board aggregates the room's newest 3 authors; after a
 * single new message that list is exactly this author followed by the previous
 * participants, so the client reproduces it by merging (dedupe by DID, cap 3)
 * rather than the server re-aggregating every message in the room.
 */
export interface RoomActivityDiffActivity {
  latestTimestamp?: string;
  latestMembers: ReadonlyArray<{
    did: string;
    name: string | null;
    avatar: string | null;
  }>;
  latestMessage?: {
    id: string;
    content: string;
    author: {
      did: string;
      name: string | null;
      avatar: string | null;
    };
    timestamp?: string;
  };
}

/** The union of what the invalidation system can emit. */
export type InvalidationEvent =
  | { kind: "queryInvalidation"; signal: QueryInvalidation }
  | { kind: "messageDiff"; signal: MessageDiff }
  | { kind: "roomMetadataDiff"; signal: RoomMetadataDiff }
  | { kind: "roomActivityDiff"; signal: RoomActivityDiff }
  | { kind: "mentionDiff"; signal: MentionDiff };


// ─── Router ─────────────────────────────────────────────────────────────

export type InvalidationListener = (
  events: readonly InvalidationEvent[],
) => void;

/**
 * InvalidationRouter is a typed pub/sub bus.
 *
 * SpaceMaterializer calls `onEventsApplied` after each batch. The router
 * runs `inferSignals` for each event and broadcasts the resulting signals
 * to all registered listeners.
 *
 * Listeners are expected to be lightweight (WS handler: enqueue frame;
 * cache: mark entry stale). Heavy work (SQL, network I/O) should be
 * deferred or batched by the listener.
 */
export interface InvalidationRouter {
  /**
   * Called by SpaceMaterializer after events have been committed to SQLite.
   * During backfill (`isBackfill: true`), signals are suppressed — there
   * are no active subscribers who care about historical data yet.
   */
  onEventsApplied(
    streamDid: StreamDid,
    events: readonly AppliedEvent[],
    meta: { isBackfill: boolean },
    db?: DbLike,
  ): void | Promise<void>;

  /**
   * Emit invalidation signals directly, outside the event pipeline.
   * Used by XRPC procedure handlers that mutate appserver-local state
   * (e.g. `updateSeen` writing to `read_positions`).
   */
  emit(signals: readonly InvalidationEvent[]): void;

  /** Register a listener. Returns an unsubscribe function. */
  subscribe(listener: InvalidationListener): () => void;
}

/**
 * A decoded event that has been successfully materialised to SQLite.
 * Carries enough context to infer invalidation signals without hitting
 * the database.
 */
export interface AppliedEvent {
  /** The event's $type. */
  type: EventType;
  /** The stream this event belongs to (space DID or personal stream DID). */
  streamDid: StreamDid;
  /** The authenticated user who created this event. */
  user: UserDid;
  /** The event's ULID. */
  id: Ulid;
  /**
   * The room the event was sent in, if applicable.
   * Present for message, reaction, link events; absent for space-level events.
   */
  roomId?: Ulid;
  /**
   * Additional event-specific fields needed for signal inference.
   * Populated by the caller based on the event $type.
   */
  details?: Readonly<Record<string, unknown>>;
}
