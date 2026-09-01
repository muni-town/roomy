/**
 * Sync handler: the bridge between the InvalidationRouter and WebSocket
 * connections.
 *
 * When a WS connection opens, the sync handler:
 *   1. Creates per-connection topic subscription state
 *   2. Subscribes to the InvalidationRouter
 *   3. Routes relevant signals to the connection based on:
 *      - Topic subscriptions (space:X / room:X)
 *      - Per-user filtering (affectedUser on QueryInvalidation)
 *
 * When a signal arrives from the InvalidationRouter:
 *   - messageDiff → #messageDiff frame to connections subscribed to that room
 *   - roomMetadataDiff → #roomMetadataDiff frame to each affected user's
 *     connections (per-user unread count, not a broadcast)
 *   - queryInvalidation → #invalidate frame to connections subscribed to the
 *     relevant topic, filtered by affectedUser
 */

import type { DecodedStreamEvent, StreamDid, UserDid } from "@roomy-space/sdk";
import type { ClientMessage, Frame, SyncSocket } from "../xrpc/types.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
  QueryNsid,
} from "../invalidation/types.ts";
import { allowsPublicJoin, roomAccess, spaceAccess } from "../auth/access.ts";
import type { DbLike } from "../db/types.ts";
import { messageFrame } from "../xrpc/frame.ts";
import { log } from "../log.ts";

// ─── Topic helpers ───────────────────────────────────────────────────────

/** Topic kinds supported by the multiplexed sync connection. */
type TopicKind = "space" | "room" | "stream" | "mentions";

/** Canonical topic string: "space:<id>" / "room:<id>" / "stream:<id>" */
type Topic = string;

function topicKey(topic: TopicKind, id: string): Topic {
  return `${topic}:${id}`;
}

/**
 * Derive the topic(s) an invalidation signal is relevant to.
 * A signal targeting a space endpoint → space topic.
 * A signal targeting a room endpoint → room topic.
 * getSpaces (no params) → all space topics (broad).
 */
function topicsForSignal(signal: InvalidationEvent["signal"]): Topic[] {
  if ("nsid" in signal) {
    const qi = signal as { nsid: QueryNsid; params: Record<string, string> };
    switch (qi.nsid) {
      case "space.roomy.space.getSpaces":
        // No specific topic — affects all spaces the user is subscribed to.
        return [];
      case "space.roomy.space.getMetadata":
      case "space.roomy.space.getThreads":
      case "space.roomy.space.getRoles":
      case "space.roomy.space.getMembers":
      case "space.roomy.space.getInvites":
      case "space.roomy.space.getActivityFeed":
      case "space.roomy.federation.getRequests":
      case "space.roomy.federation.getIncoming":
      case "space.roomy.federation.getOutgoing":
      case "space.roomy.federation.getGrants":
        return qi.params["spaceId"]
          ? [topicKey("space", qi.params["spaceId"])]
          : [];
      case "space.roomy.room.getMetadata":
      case "space.roomy.room.getMessages":
      case "space.roomy.room.getThreads":
        return qi.params["roomId"]
          ? [topicKey("room", qi.params["roomId"])]
          : [];
      case "space.roomy.message.getMessage":
        // No specific topic — message invalidation doesn't map to a single room.
        // The client handles this via invalidating the specific query key.
        return [];
    }
  }

  // messageDiff — has roomId directly.
  if ("roomId" in signal) {
    const md = signal as { roomId: string };
    return [topicKey("room", md.roomId)];
  }

  return [];
}

// ─── Connection state ────────────────────────────────────────────────────

interface StreamSubscription {
  /** Stream DID being subscribed to. */
  streamDid: string;
  /** Last-delivered event idx (exclusive cursor). Advances as events are sent. */
  cursor: number;
  /** True while the initial backfill loop is still draining history. */
  backfilling: boolean;
  /**
   * Set when a live event arrives while backfilling is in progress. The
   * backfill loop checks this after each iteration and, if set, performs
   * one more drain to pick up the straggler events that were skipped by
   * #onStreamEvents (which can't deliver during backfill to preserve
   * cursor ordering).
   */
  pendingLive: boolean;
}

interface ConnectionState {
  /** Connection ID (key into #connections). */
  connId: number;
  /** The topics this connection is currently subscribed to. */
  topics: Set<Topic>;
  /** Per-stream subscription state (keyed by stream DID). */
  streams: Map<string, StreamSubscription>;
  /** Authenticated DID of the connected user. */
  did: string;
  /** Whether the connection is still open. */
  isOpen: boolean;
  /** Send a frame to the client. */
  send: (frame: Frame) => void;
}

// ─── Sync manager ────────────────────────────────────────────────────────

/**
 * Minimal interface the SyncManager needs from StreamManager: a live-event
 * subscription hook and a cursor-based backfill read. Defined as an interface
 * so tests can supply a lightweight mock without casting to the full class.
 */
export interface StreamEventSource {
  onEvents(listener: (streamDid: StreamDid, events: readonly DecodedStreamEvent[]) => void): () => void;
  getEventsFrom(streamDid: StreamDid, cursor: number, limit: number): Promise<{ events: DecodedStreamEvent[]; cursor: number }>;
}

/**
 * Minimal DB surface the SyncManager needs for topic authorization.
 *
 * The manager must resolve a room's owning space (via the global
 * `entity_space` index) and then run `roomAccess`/`spaceAccess` against the
 * per-space DB — the same primitives the HTTP read path uses. Defined as an
 * interface so unit tests can supply a lightweight mock without a real pool.
 */
export interface SyncDbAccess {
  /** Resolve the space DID owning `entityId` (room/message) via the global
   *  `entity_space` index, then return a handle to that space's per-space DB.
   *  Returns null when the entity doesn't exist. */
  openSpaceDbForEntity(entityId: string): Promise<DbLike | null>;
  /** Return a handle to the per-space DB for `spaceDid`. */
  openSpaceDb(spaceDid: string): DbLike;
}

/** Max events per backfill batch. */
const BACKFILL_BATCH = 100;

/**
 * Manages all active sync connections and routes invalidation signals.
 * Subscribes to the InvalidationRouter once at creation time.
 */
export class SyncManager {
  readonly #connections = new Map<number, ConnectionState>();
  /** Reverse index: topic → set of connection IDs subscribed to it. */
  readonly #topicIndex = new Map<Topic, Set<number>>();
  /** Reverse index: stream DID → set of connection IDs subscribed to it. */
  readonly #streamIndex = new Map<string, Set<number>>();
  /** Monotonically increasing connection ID. */
  #nextConnId = 0;
  /** Cleanup function for the router subscription. */
  readonly #unsubscribe: () => void;
  /** Cleanup function for the StreamManager live-event subscription. */
  readonly #unsubscribeStreams: () => void;
  /** Stream event source for backfill reads. */
  readonly #streamSource: StreamEventSource;
  /** DB accessor for topic authorization (room/space/stream access checks). */
  readonly #db: SyncDbAccess;
  /**
   * Short-TTL cache of room read-access decisions for delivery-time re-checks
   * (see #routeMessageDiff). Keyed by `${did}\0${roomId}`. The TTL bounds how
   * long a revoked user keeps receiving content frames after losing access.
   */
  readonly #roomAccessCache = new Map<string, { at: number; canRead: boolean }>();
  /** TTL for the delivery-time room access cache (ms). */
  readonly #roomAccessTtlMs: number;
  /**
   * Short-TTL cache of stream (space) read-access decisions for
   * delivery-time re-checks (see #onStreamEvents / #backfillStream). Keyed
   * by `${did}\0${streamDid}`.
   */
  readonly #streamAccessCache = new Map<string, { at: number; canRead: boolean }>();
  /** TTL for the delivery-time stream access cache (ms). */
  readonly #streamAccessTtlMs: number;

  constructor(
    router: InvalidationRouter,
    streamManager: StreamEventSource,
    db: SyncDbAccess,
    opts: { accessCacheTtlMs?: number } = {},
  ) {
    this.#streamSource = streamManager;
    this.#db = db;
    // Default 5s: bounds how long a revoked user keeps receiving content
    // frames after losing access without a DB round-trip per frame per
    // connection. Tests pass 0 to force a re-check on every delivery.
    this.#roomAccessTtlMs = opts.accessCacheTtlMs ?? 5_000;
    this.#streamAccessTtlMs = opts.accessCacheTtlMs ?? 5_000;
    this.#unsubscribe = router.subscribe((events) => this.#onSignals(events));
    this.#unsubscribeStreams = streamManager.onEvents((streamDid, events) =>
      this.#onStreamEvents(streamDid, events),
    );
   }

  /** Register a new sync connection. Returns a connection ID. */
  register(socket: SyncSocket): number {
    const connId = this.#nextConnId++;
    const state: ConnectionState = {
      connId,
      topics: new Set(),
      streams: new Map(),
      did: socket.did,
      isOpen: true,
      send: (frame) => {
        socket.send(frame);
      },
    };
    this.#connections.set(connId, state);

    // Handle client messages.
    socket.onMessage((msg: ClientMessage) => {
      if (msg.type === "sub" && msg.topic === "stream") {
        void this.#handleStreamSub(state, msg.id, msg.cursor ?? -1);
        return;
      }
      if (msg.type === "unsub" && msg.topic === "stream") {
        this.#stopStreamSub(state, msg.id);
        return;
      }
      if (msg.type === "sub") {
        // A connection may only subscribe to its own mentions — the DID is
        // the stable ID, and eavesdropping on another user's mentions is not
        // allowed. Ignore (don't subscribe) otherwise.
        if (msg.topic === "mentions" && msg.id !== state.did) {
          return;
        }
        // Room/space/stream subscriptions are gated on the same access the
        // HTTP read path grants (roomAccess / spaceAccess). Denied subs are
        // silently ignored — no topic registered, no frames, no backfill —
        // matching the mentions-topic behaviour. The check is async (DB
        // queries), so the topic is only registered once access is confirmed.
        if (msg.topic === "room" || msg.topic === "space") {
          void this.#handleTopicSub(state, msg.topic, msg.id);
          return;
        }
        // Only "mentions" reaches here (stream is handled above; room/space
        // are handled by #handleTopicSub). A connection may only subscribe
        // to its own mentions — the DID is the stable ID, and eavesdropping
        // on another user's mentions is not allowed. Ignore otherwise.
        const topic = topicKey(msg.topic, msg.id);
        state.topics.add(topic);

        let subs = this.#topicIndex.get(topic);
        if (!subs) {
          subs = new Set();
          this.#topicIndex.set(topic, subs);
        }
        subs.add(connId);
      } else if (msg.type === "unsub") {
        const topic = topicKey(msg.topic, msg.id);
        state.topics.delete(topic);
        this.#topicIndex.get(topic)?.delete(connId);
      } else if (msg.type === "cursor") {
        // Cursor replay is a future concern (ring buffer for missed diffs).
        // For now, send a broad invalidation for all currently subscribed
        // topics so the client re-fetches fresh data via HTTP.
        this.#sendFullInvalidation(connId, state);
      }
    });

    socket.onClose(() => {
      state.isOpen = false;
      this.#connections.delete(connId);
      for (const topic of state.topics) {
        this.#topicIndex.get(topic)?.delete(connId);
      }
      state.topics.clear();
      for (const streamDid of state.streams.keys()) {
        this.#streamIndex.get(streamDid)?.delete(connId);
      }
      state.streams.clear();
    });

    return connId;
  }

  /** Total active connections (for diagnostics). */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /**
   * Authorize and register a room/space topic subscription. The access check
   * mirrors the HTTP read path:
   *   - room:<id>  → roomAccess(spaceDb, roomId, did).canRead (and exists),
   *     resolving the owning space via the global entity_space index.
   *   - space:<id> → spaceAccess(spaceDb, spaceId, did): deny if banned;
   *     otherwise mirror HTTP read semantics (public spaces readable by
   *     non-members, invite-only requires membership).
   * Denied subs are silently ignored — no topic registered, no frames.
   */
  async #handleTopicSub(
    state: ConnectionState,
    kind: "room" | "space",
    id: string,
  ): Promise<void> {
    if (!state.isOpen) return;
    const allowed = await this.#canReadTopic(kind, id, state.did);
    if (!allowed) return;
    if (!state.isOpen) return;

    const topic = topicKey(kind, id);
    state.topics.add(topic);

    let subs = this.#topicIndex.get(topic);
    if (!subs) {
      subs = new Set();
      this.#topicIndex.set(topic, subs);
    }
    subs.add(state.connId);

    // When subscribing to a room topic, immediately invalidate
    // room-scoped queries so the client re-fetches fresh data.
    // Without this, a client that navigates away and back will
    // serve stale TanStack cache (staleTime: Infinity) and miss
    // any messages/invalidation frames that arrived while it was
    // unsubscribed.
    if (kind === "room") {
      this.#sendRoomInvalidation(state, id);
    }
  }

  /**
   * Authorize and register a stream (raw event) subscription. Stream topics
   * carry full message content, so access requires membership or admin of the
   * space (the space DID is the stream DID); banned users are denied. Denied
   * subs are silently ignored — no stream registered, no backfill.
   */
  async #handleStreamSub(
    state: ConnectionState,
    streamDid: string,
    cursor: number,
  ): Promise<void> {
    if (!state.isOpen) return;
    const allowed = await this.#canReadStream(streamDid, state.did);
    if (!allowed) return;
    if (!state.isOpen) return;
    this.#startStreamSub(state, streamDid, cursor);
  }

  /**
   * Whether the caller may read the given topic over the HTTP read path.
   * Room topics resolve their owning space via the global entity_space index
   * (openSpaceDbForEntity), then reuse roomAccess — the same check
   * getMessages/getThreads run. Space topics reuse spaceAccess with the
   * public-join gate (getMetadata/getSpaceSummary semantics).
   */
  async #canReadTopic(
    kind: "room" | "space",
    id: string,
    did: string,
  ): Promise<boolean> {
    try {
      if (kind === "room") {
        const db = await this.#db.openSpaceDbForEntity(id);
        if (!db) return false;
        const access = await roomAccess(db, id, did);
        return access.exists && access.canRead;
      }
      const db = this.#db.openSpaceDb(id);
      const access = await spaceAccess(db, id, did);
      if (access.isBanned) return false;
      if (access.isMember || access.isAdmin) return true;
      // Public spaces are readable by non-members (getMetadata/getSpaceSummary
      // semantics); invite-only spaces require membership.
      return await allowsPublicJoin(db, id);
    } catch (err) {
      log.error(
        `Sync topic access check failed for ${kind}:${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Whether the caller may subscribe to a stream (space DID). Streams carry
   * raw message content, so this is stricter than the space topic: require
   * membership or admin, deny banned users.
   */
  async #canReadStream(streamDid: string, did: string): Promise<boolean> {
    try {
      const db = this.#db.openSpaceDb(streamDid);
      const access = await spaceAccess(db, streamDid, did);
      if (access.isBanned) return false;
      return access.isMember || access.isAdmin;
    } catch (err) {
      log.error(
        `Sync stream access check failed for ${streamDid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Delivery-time re-check for room content frames (#messageDiff). A user who
   * loses access mid-connection (banned/removed) must stop receiving message
   * content. The decision is memoized with a short TTL so the hot path does
   * not do a DB round-trip per frame per connection.
   */
  async #canReceiveRoomContent(roomId: string, did: string): Promise<boolean> {
    const key = `${did}\0${roomId}`;
    const now = Date.now();
    const cached = this.#roomAccessCache.get(key);
    if (cached && now - cached.at < this.#roomAccessTtlMs) {
      return cached.canRead;
    }
    let canRead = false;
    try {
      const db = await this.#db.openSpaceDbForEntity(roomId);
      if (db) {
        const access = await roomAccess(db, roomId, did);
        canRead = access.exists && access.canRead;
      }
    } catch (err) {
      log.error(
        `Sync delivery access check failed for room ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      canRead = false;
    }
    this.#roomAccessCache.set(key, { at: now, canRead });
    return canRead;
  }

  /** Tear down the manager (tests only). */
  destroy(): void {
    this.#unsubscribe();
    this.#unsubscribeStreams();
    this.#connections.clear();
    this.#topicIndex.clear();
    this.#streamIndex.clear();
  }

  // ─── Signal routing ────────────────────────────────────────────────
  #onSignals(events: readonly InvalidationEvent[]): void {
    for (const event of events) {
      if (event.kind === "messageDiff") {
        this.#routeMessageDiff(event.signal);
      } else if (event.kind === "mentionDiff") {
        this.#routeMentionDiff(event.signal);
      } else if (event.kind === "roomMetadataDiff") {
        this.#routeRoomMetadataDiff(event.signal);
      } else if (event.kind === "queryInvalidation") {
        this.#routeQueryInvalidation(event.signal);
      }
    }
  }

  #routeMessageDiff(
    signal: InvalidationEvent["signal"] & {
      roomId: string;
      seq: number;
      ops: unknown[];
    },
  ): void {
    const topic = topicKey("room", signal.roomId);
    const connIds = this.#topicIndex.get(topic);
    if (!connIds) return;

    const frame = messageFrame("#messageDiff", {
      roomId: signal.roomId,
      seq: signal.seq,
      ops: signal.ops,
    });

    // Delivery-time re-check: a connection may only receive content frames
    // for rooms it can still read. Sub-time checks alone leave a window — a
    // user banned/removed mid-connection would keep receiving message content
    // until they reconnect. The access decision is memoized with a short TTL
    // (see #canReceiveRoomContent) so the hot path doesn't do a DB round-trip
    // per frame per connection.
    void this.#deliverMessageDiff(signal.roomId, connIds, frame);
  }

  async #deliverMessageDiff(
    roomId: string,
    connIds: Set<number>,
    frame: Frame,
  ): Promise<void> {
    for (const connId of connIds) {
      const conn = this.#connections.get(connId);
      if (!conn?.isOpen) continue;
      if (!(await this.#canReceiveRoomContent(roomId, conn.did))) continue;
      conn.send(frame);
    }
  }

  #routeMentionDiff(
    signal: InvalidationEvent["signal"] & {
      did: string;
      spaceId: string;
      roomId: string;
      seq: number;
      ops: unknown[];
    },
  ): void {
    const topic = topicKey("mentions", signal.did);
    const connIds = this.#topicIndex.get(topic);
    if (!connIds) return;

    const frame = messageFrame("#mention", {
      did: signal.did,
      spaceId: signal.spaceId,
      roomId: signal.roomId,
      seq: signal.seq,
      ops: signal.ops,
    });

    for (const connId of connIds) {
      const conn = this.#connections.get(connId);
      if (conn?.isOpen) {
        conn.send(frame);
      }
    }
  }

  #routeRoomMetadataDiff(
    signal: InvalidationEvent["signal"] & {
      spaceId: string;
      roomId: string;
      seq: number;
      delta: number;
      users: ReadonlyArray<string>;
      parentChannelId?: string;
      roomUnreadDeltas?: ReadonlyMap<string, number>;
      threadUnreadDeltas?: ReadonlyMap<string, number>;
    },
  ): void {
    // Per-user: the frame carries a delta (the same for every user), but
    // we still send one frame per user rather than broadcasting — only
    // users with a read_positions row for this room should see the unread
    // bump. A user may have multiple connections open (multiple tabs).
    for (const user of signal.users) {
      const frame = messageFrame("#roomMetadataDiff", {
        spaceId: signal.spaceId,
        roomId: signal.roomId,
        delta: signal.delta,
        seq: signal.seq,
        ...(signal.parentChannelId ? { parentChannelId: signal.parentChannelId } : {}),
        ...(signal.roomUnreadDeltas?.get(user)
          ? { roomUnreadDelta: signal.roomUnreadDeltas.get(user) }
          : {}),
        ...(signal.threadUnreadDeltas?.get(user)
          ? { threadUnreadDelta: signal.threadUnreadDeltas.get(user) }
          : {}),
      });
      for (const conn of this.#connections.values()) {
        if (!conn.isOpen) continue;
        if (conn.did !== user) continue;
        conn.send(frame);
      }
    }
  }

  #routeQueryInvalidation(
    signal: InvalidationEvent["signal"] & {
      nsid: QueryNsid;
      params: Record<string, string>;
      affectedUser?: UserDid;
    },
  ): void {
    const topics = topicsForSignal(signal);

    // getSpaces has no specific topic — broadcast to ALL connections
    // filtered by affectedUser. Unlike space/room-scoped queries,
    // getSpaces is user-scoped and relevant regardless of which topics
    // the connection is currently subscribed to (e.g. the user may be
    // on /new or / with no space topic, but still needs their space
    // list to update when a space is created or joined).
    // getActivityFeed is likewise a global per-user query — a reaction
    // on any room's latest message must refresh every viewer's feed.
    if (
      signal.nsid === "space.roomy.space.getSpaces" ||
      signal.nsid === "space.roomy.space.getActivityFeed"
    ) {
      const frame = messageFrame("#invalidate", {
        nsid: signal.nsid,
        params: signal.params,
      });
      for (const conn of this.#connections.values()) {
        if (!conn.isOpen) continue;
        // If affectedUser is set, only send to that user.
        if (signal.affectedUser && conn.did !== signal.affectedUser) continue;
        conn.send(frame);
      }
      return;
    }

    // getMessage has no topic — skip WS delivery for now. The client
    // will re-fetch via HTTP when the parent room query is invalidated.
    if (topics.length === 0) return;

    const frame = messageFrame("#invalidate", {
      nsid: signal.nsid,
      params: signal.params,
    });

    for (const topic of topics) {
      const connIds = this.#topicIndex.get(topic);
      if (!connIds) continue;

      for (const connId of connIds) {
        const conn = this.#connections.get(connId);
        if (!conn?.isOpen) continue;
        // Per-user filtering.
        if (signal.affectedUser && conn.did !== signal.affectedUser) continue;
        conn.send(frame);
      }
    }
  }

  // ─── Cursor / reconnect ────────────────────────────────────────────

  /** Send #invalidate for all subscribed queries (full re-fetch). */
  #sendFullInvalidation(_connId: number, state: ConnectionState): void {
    const nsids: QueryNsid[] = [
      "space.roomy.space.getSpaces",
      "space.roomy.space.getMetadata",
      "space.roomy.space.getThreads",
      "space.roomy.space.getRoles",
      "space.roomy.space.getMembers",
      "space.roomy.space.getInvites",
      "space.roomy.room.getMetadata",
      "space.roomy.room.getMessages",
      "space.roomy.room.getThreads",
      "space.roomy.message.getMessage",
    ];

    // Collect unique space/room IDs from subscribed topics.
    const spaceIds = new Set<string>();
    const roomIds = new Set<string>();
    for (const topic of state.topics) {
      const [kind, id] = topic.split(":") as [string, string];
      if (kind === "space") spaceIds.add(id);
      else if (kind === "room") roomIds.add(id);
    }

    // Invalidate getSpaces (no params needed).
    state.send(
      messageFrame("#invalidate", {
        nsid: "space.roomy.space.getSpaces",
        params: {},
      }),
    );

    // Invalidate the global activity feed (prefix-matches any
    // spaceId/limit variant the client has cached).
    state.send(
      messageFrame("#invalidate", {
        nsid: "space.roomy.space.getActivityFeed",
        params: {},
      }),
    );

    // Invalidate per-space endpoints.
    for (const spaceId of spaceIds) {
      for (const nsid of nsids) {
        if (
          nsid.startsWith("space.roomy.space.") &&
          nsid !== "space.roomy.space.getSpaces"
        ) {
          state.send(
            messageFrame("#invalidate", {
              nsid,
              params: { spaceId },
            }),
          );
        }
      }
    }

    // Invalidate per-room endpoints.
    for (const roomId of roomIds) {
      for (const nsid of nsids) {
        if (nsid.startsWith("space.roomy.room.")) {
          state.send(
            messageFrame("#invalidate", {
              nsid,
              params: { roomId },
            }),
          );
        }
      }
    }
  }

  /**
   * Send #invalidate for all room-scoped queries to one connection.
   * Called when a client subscribes to a room topic that it was
   * previously unsubscribed from. This ensures the client re-fetches
   * fresh data rather than serving stale TanStack cache entries that
   * accumulated while it wasn't subscribed.
   */
  #sendRoomInvalidation(state: ConnectionState, roomId: string): void {
    const roomNsids: Array<{ nsid: QueryNsid }> = [
      { nsid: "space.roomy.room.getMessages" },
      { nsid: "space.roomy.room.getMetadata" },
      { nsid: "space.roomy.room.getThreads" },
    ];
    for (const { nsid } of roomNsids) {
      state.send(
        messageFrame("#invalidate", {
          nsid,
          params: { roomId },
        }),
      );
    }
  }

  // ─── Stream (raw event) subscriptions ───────────────────────────────

  /**
   * Start a stream subscription: register in the stream index, then
   * asynchronously backfill from the given cursor. Live events arriving
   * while backfill is in progress are queued by the cursor — they'll be
   * fetched in a later backfill batch once the initial drain catches up.
   */
  #startStreamSub(state: ConnectionState, streamDid: string, cursor: number): void {
    // Replace any existing subscription for this stream on this connection.
    const existing = state.streams.get(streamDid);
    const alreadyBackfilling = existing?.backfilling === true;
    if (existing) {
      // Don't reset backfilling — a concurrent backfill loop (if any) will
      // pick up the updated cursor at its next iteration. Only kick off a
      // new backfill below if one isn't already in flight.
      existing.cursor = cursor;
    } else {
      state.streams.set(streamDid, { streamDid, cursor, backfilling: false, pendingLive: false });
      let subs = this.#streamIndex.get(streamDid);
      if (!subs) {
        subs = new Set();
        this.#streamIndex.set(streamDid, subs);
      }
      subs.add(state.connId);
    }
    // Kick off backfill only if no loop is already running for this stream.
    // Don't await — live events may arrive concurrently and will be
    // delivered once the cursor catches up.
    if (!alreadyBackfilling) {
      this.#backfillStream(state, streamDid).catch((err) => {
        log.error(
          `Stream backfill failed for ${streamDid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  /** Stop a stream subscription. */
  #stopStreamSub(state: ConnectionState, streamDid: string): void {
    if (!state.streams.delete(streamDid)) return;
    const subs = this.#streamIndex.get(streamDid);
    if (subs) {
      subs.delete(state.connId);
      if (subs.size === 0) this.#streamIndex.delete(streamDid);
    }
  }
  async #backfillStream(state: ConnectionState, streamDid: string): Promise<void> {
    const sub = state.streams.get(streamDid);
    if (!sub || sub.backfilling) return;
    sub.backfilling = true;
    try {
      for (;;) {
        if (!state.isOpen || state.streams.get(streamDid) !== sub) return;
        const { events, cursor } = await this.#streamSource.getEventsFrom(
          streamDid as StreamDid,
          sub.cursor,
          BACKFILL_BATCH,
        );
        if (events.length === 0) break;
        const hasMore = events.length >= BACKFILL_BATCH;
        await this.#sendStreamEvents(state, streamDid, events, cursor, hasMore);
        sub.cursor = cursor;
        if (!hasMore) break;
      }
      // A live event may have arrived during the backfill await and been
      // skipped by #onStreamEvents (which can't deliver while backfilling).
      // Drain the straggler events, looping until no more were armed during
      // the await. The identity guard ensures a replaced sub stops draining.
      if (!state.isOpen || state.streams.get(streamDid) !== sub) return;
      while (sub.pendingLive) {
        sub.pendingLive = false;
        const { events, cursor } = await this.#streamSource.getEventsFrom(
          streamDid as StreamDid,
          sub.cursor,
          BACKFILL_BATCH,
        );
        if (events.length > 0) {
          await this.#sendStreamEvents(state, streamDid, events, cursor, false);
          sub.cursor = cursor;
        }
      }
    } finally {
      sub.backfilling = false;
    }
  }

  /**
   * Route live stream events from the StreamManager to all connections
   * subscribed to that stream. Events are only sent to connections that
   * have finished their initial backfill (so cursor ordering is preserved);
   * events arriving during backfill are picked up by the next backfill
   * batch via the cursor.
   */
  #onStreamEvents(streamDid: string, events: readonly DecodedStreamEvent[]): void {
    if (events.length === 0) return;
    const subs = this.#streamIndex.get(streamDid);
    if (!subs || subs.size === 0) return;
    for (const connId of subs) {
      const state = this.#connections.get(connId);
      if (!state || !state.isOpen) continue;
      const sub = state.streams.get(streamDid);
      if (!sub) continue;
      if (sub.backfilling) {
        // Can't deliver live during backfill (would break cursor ordering).
        // Flag so the backfill loop performs one more drain after it catches
        // up, picking up these straggler events.
        sub.pendingLive = true;
        continue;
      }
      // Advance the cursor past these events. The advance is deferred until
      // the delivery access check resolves; guard against out-of-order
      // resolution (concurrent batches) by only moving forward.
      const cursor = events[events.length - 1]!.idx;
      void this.#sendStreamEvents(state, streamDid, events, cursor, false).then(
        () => {
          if (cursor > sub.cursor) sub.cursor = cursor;
        },
      );
    }
  }

  /**
   * Delivery-time re-check for stream content frames (#streamEvents). A user
   * who loses access mid-connection (banned/removed) must stop receiving raw
   * events. Memoized with a short TTL like the room check.
   */
  async #canReceiveStream(streamDid: string, did: string): Promise<boolean> {
    const key = `${did}\0${streamDid}`;
    const now = Date.now();
    const cached = this.#streamAccessCache.get(key);
    if (cached && now - cached.at < this.#streamAccessTtlMs) {
      return cached.canRead;
    }
    let canRead = false;
    try {
      const db = this.#db.openSpaceDb(streamDid);
      const access = await spaceAccess(db, streamDid, did);
      canRead = !access.isBanned && (access.isMember || access.isAdmin);
    } catch (err) {
      log.error(
        `Sync stream delivery access check failed for ${streamDid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      canRead = false;
    }
    this.#streamAccessCache.set(key, { at: now, canRead });
    return canRead;
  }

  /**
   * Send a #streamEvents frame containing a batch of raw events.
   * `hasMore` indicates whether more backfill batches are following.
   * Delivery is gated on the connection still having stream read access
   * (membership/admin, not banned) so revoked users stop receiving content.
   */
  async #sendStreamEvents(
    state: ConnectionState,
    streamDid: string,
    events: readonly DecodedStreamEvent[],
    cursor: number,
    hasMore: boolean,
  ): Promise<void> {
    if (!state.isOpen) return;
    if (!(await this.#canReceiveStream(streamDid, state.did))) return;
    if (!state.isOpen) return;
    state.send(
      messageFrame("#streamEvents", {
        streamDid,
        cursor,
        hasMore,
        events: events.map((e) => ({
          idx: e.idx,
          user: e.user,
          payload: e.event,
        })),
      }),
    );
  }

}

// ─── Helpers ─────────────────────────────────────────────────────────────

function hasSpaceTopic(topics: Set<string>): boolean {
  for (const t of topics) {
    if (t.startsWith("space:")) return true;
  }
  return false;
}

// ─── Singleton ──────────────────────────────────────────────────────────

let syncManagerInstance: SyncManager | null = null;

/**
 * Set the process-wide SyncManager singleton. Called once at startup
 * from createSyncSubscribeHandler.
 */
export function setSyncManager(sm: SyncManager): void {
  syncManagerInstance = sm;
}

/**
 * Get the process-wide SyncManager singleton, or null if not yet set.
 */
export function getSyncManager(): SyncManager | null {
  return syncManagerInstance;
}

/**
 * Reset the singleton (tests only).
 */
export function _resetSyncManager(): void {
  syncManagerInstance = null;
}
