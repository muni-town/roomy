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
 *   - queryInvalidation → #invalidate frame to connections subscribed to the
 *     relevant topic, filtered by affectedUser
 */

import type { UserDid } from "@roomy-space/sdk";
import type { ClientMessage, SyncSocket } from "../xrpc/types.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
  QueryNsid,
} from "../invalidation/types.ts";
import { messageFrame } from "../xrpc/frame.ts";

// ─── Topic helpers ───────────────────────────────────────────────────────

/** Canonical topic string: "space:<id>" or "room:<id>" */
type Topic = string;

function topicKey(topic: "space" | "room", id: string): Topic {
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

interface ConnectionState {
  /** The topics this connection is currently subscribed to. */
  topics: Set<Topic>;
  /** Authenticated DID of the connected user. */
  did: string;
  /** Whether the connection is still open. */
  isOpen: boolean;
  /** Send a frame to the client. */
  send: (frame: import("../xrpc/types.ts").Frame) => void;
}

// ─── Sync manager ────────────────────────────────────────────────────────

/**
 * Manages all active sync connections and routes invalidation signals.
 * Subscribes to the InvalidationRouter once at creation time.
 */
export class SyncManager {
  readonly #connections = new Map<number, ConnectionState>();
  /** Reverse index: topic → set of connection IDs subscribed to it. */
  readonly #topicIndex = new Map<Topic, Set<number>>();
  /** Monotonically increasing connection ID. */
  #nextConnId = 0;
  /** Cleanup function for the router subscription. */
  readonly #unsubscribe: () => void;

  constructor(router: InvalidationRouter) {
    this.#unsubscribe = router.subscribe((events) => this.#onSignals(events));
  }

  /** Register a new sync connection. Returns a connection ID. */
  register(socket: SyncSocket): number {
    const connId = this.#nextConnId++;
    const state: ConnectionState = {
      topics: new Set(),
      did: socket.did,
      isOpen: true,
      send: (frame) => {
        if (state.isOpen) socket.send(frame);
      },
    };
    this.#connections.set(connId, state);

    // Handle client messages.
    socket.onMessage((msg: ClientMessage) => {
      if (msg.type === "sub") {
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
    });

    return connId;
  }

  /** Total active connections (for diagnostics). */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Tear down the manager (tests only). */
  destroy(): void {
    this.#unsubscribe();
    this.#connections.clear();
    this.#topicIndex.clear();
  }

  // ─── Signal routing ────────────────────────────────────────────────

  #onSignals(events: readonly InvalidationEvent[]): void {
    for (const event of events) {
      if (event.kind === "messageDiff") {
        this.#routeMessageDiff(event.signal);
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

    for (const connId of connIds) {
      const conn = this.#connections.get(connId);
      if (conn?.isOpen) {
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
    if (signal.nsid === "space.roomy.space.getSpaces") {
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
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function hasSpaceTopic(topics: Set<string>): boolean {
  for (const t of topics) {
    if (t.startsWith("space:")) return true;
  }
  return false;
}
