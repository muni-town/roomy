/**
 * Types for the invalidation system.
 *
 * An InvalidationSignal is emitted whenever a Leaf event changes data that
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
  | "space.roomy.space.getRoles"
  | "space.roomy.space.getMembers"
  | "space.roomy.space.getInvites"
  | "space.roomy.space.getActivityFeed"
  | "space.roomy.room.getMetadata"
  | "space.roomy.room.getMessages"
  | "space.roomy.room.getThreads"
  | "space.roomy.message.getMessage"
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
}

/** A message-level add/update/remove within a room. */
export interface MessageDiff {
  roomId: Ulid;
  /** Monotonically increasing sequence number for cursor replay. */
  seq: number;
  ops: MessageDiffOp[];
}

export type MessageDiffOp =
  | { op: "add"; key: Ulid; message: MessageSnapshot }
  | { op: "update"; key: Ulid; message: MessageSnapshot }
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
 * Replaces the broad `getSpaces` + `space.getMetadata` invalidation that
 * previously fired on every message create — the client patches
 * `room.getMetadata.unreadCount`, the matching `SpaceRow.unreadCount` in
 * `getSpaces`, and the channel's `unreadCount` in the `space.getMetadata`
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
}

/** The union of what the invalidation system can emit. */
export type InvalidationEvent =
  | { kind: "queryInvalidation"; signal: QueryInvalidation }
  | { kind: "messageDiff"; signal: MessageDiff }
  | { kind: "roomMetadataDiff"; signal: RoomMetadataDiff };

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
   * Emit invalidation signals directly, outside the Leaf event pipeline.
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
