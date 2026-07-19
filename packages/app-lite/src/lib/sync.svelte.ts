/**
 * Wraps SDK sync primitives (SyncConnection / SyncRouter / TopicManager)
 * with app-lite's QueryClient cache adapter + ticket fetch.
 */

import { cache, sync, transport } from "@roomy-space/sdk";
import type {
  SyncConnectionLike,
  TopicManagerLike,
} from "@roomy-space/sdk/svelte";
import { createTanstackCacheAdapter } from "@roomy-space/sdk/browser";
import type { QueryClient } from "@tanstack/svelte-query";
import { queryClient } from "./client";
import { px } from "./auth.svelte";
import { CONFIG } from "./config";

const { SyncConnection, SyncRouter, TopicManager } = sync;
const { resolveAppserverWsOrigin } = transport;

/** Simplified sync status for UI consumption. */
export type SyncStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "reconnecting"; attempt: number; delayMs: number }
  | { state: "disconnected" };

export interface SyncContext {
  connect: () => Promise<void>;
  disconnect: () => void;
  readonly connection: SyncConnectionLike;
  readonly topicManager: TopicManagerLike;
  readonly status: SyncStatus;
}

function mapStatus(s: sync.ConnectionStatus): SyncStatus {
  switch (s.state) {
    case "idle":
      return { state: "idle" };
    case "connecting":
      return { state: "connecting" };
    case "open":
      return { state: "connected" };
    case "reconnecting":
      return { state: "reconnecting", attempt: s.attempt, delayMs: s.delayMs };
    case "closing":
    case "closed":
      return { state: "disconnected" };
  }
}

export function createSyncContext(deps: {
  queryClient: QueryClient;
  appserverDid: string;
  onLog?: (msg: string) => void;
  onMessageDiff?: (roomId: string, seq: number) => void;
}): SyncContext {
  const { queryClient: qc, appserverDid, onLog, onMessageDiff } = deps;

  let connection = $state<InstanceType<typeof SyncConnection> | null>(null);
  let router: InstanceType<typeof SyncRouter> | null = null;
  let topics = $state<InstanceType<typeof TopicManager> | null>(null);
  let syncStatus = $state<SyncStatus>({ state: "idle" });

  function log(msg: string) {
    console.log(`[sync] ${msg}`);
    onLog?.(msg);
  }

  async function fetchTicket(): Promise<string> {
    log("Fetching WS connection ticket…");
    try {
      const res = await px().procedure(
        "space.roomy.auth.getConnectionTicket",
        {},
      );
      log(`Got ticket: ${res.ticket?.slice(0, 8)}…`);
      return res.ticket;
    } catch (err) {
      log(
        `Ticket fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  async function connect() {
    if (connection) return;

    let wsOrigin: string;
    if (CONFIG.appserverWsOrigin) {
      wsOrigin = CONFIG.appserverWsOrigin;
      log(`Using configured WS origin: ${wsOrigin}`);
    } else {
      wsOrigin = await resolveAppserverWsOrigin(appserverDid);
      log(`Resolved WS origin from DID: ${wsOrigin}`);
    }

    connection = new SyncConnection({
      wsUrl: `${wsOrigin.replace(/\/+$/, "")}/xrpc/space.roomy.sync.subscribe`,
      fetchTicket,
      logger: log,
    });

    connection.onFrame((frame) => {
      const t = frame.header["t"];
      log(`[frame] t=${t}`);
      if (t === "#messageDiff") {
        const body = frame.body as {
          seq?: number;
          roomId?: string;
          ops?: unknown[];
        };
        log(
          `[messageDiff] roomId=${body.roomId} seq=${body.seq} ops=${JSON.stringify(body.ops)?.slice(0, 200)}`,
        );
        if (typeof body.roomId === "string" && typeof body.seq === "number") {
          onMessageDiff?.(body.roomId, body.seq);
        }
      } else if (t === "#roomMetadataDiff") {
        const body = frame.body as {
          spaceId?: string;
          roomId?: string;
          delta?: number;
          seq?: number;
        };
        log(
          `[roomMetadataDiff] spaceId=${body.spaceId} roomId=${body.roomId} delta=${body.delta} seq=${body.seq}`,
        );
        // The seq shares the same global counter as #messageDiff, so feed
        // it into the same gap-detection path.
        if (typeof body.roomId === "string" && typeof body.seq === "number") {
          onMessageDiff?.(body.roomId, body.seq);
        }
      } else if (t === "#invalidate") {
        const body = frame.body as { nsid?: string; params?: unknown };
        log(
          `[invalidate] nsid=${body.nsid} params=${JSON.stringify(body.params)}`,
        );
      }
    });

    connection.onStatusChange((status) => {
      syncStatus = mapStatus(status);
      log(`[status] ${JSON.stringify(status)}`);
    });

    connection.onError((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[error] ${msg}`);
      // 429s from the ticket fetch (an XRPC procedure) are already retried
      // with Retry-After backoff inside DirectXrpcClient.procedure before
      // they reach here. If we still see a RateLimitError, the retry budget
      // is exhausted — SyncConnection's own reconnect backoff takes over.
      if (msg.includes("429") || msg.includes("RateLimit")) {
        log(`[error] Rate limited by server — retry budget exhausted, deferring to WS reconnect backoff`);
      }
    });

    connection.onClose((info) => {
      log(
        `[close] code=${info.code} reason=${info.reason} intentional=${info.intentional}`,
      );
    });

    router = new SyncRouter(connection, createTanstackCacheAdapter(qc), {
      onValidationError: ({ frameType, summary }) =>
        log(`[validation error ${frameType}] ${summary}`),
      onUnknownFrame: (f) => log(`[unknown frame] ${JSON.stringify(f.header)}`),
    });
    router.start();
    topics = new TopicManager(connection);

    await connection.connect();
  }

  function disconnect() {
    router?.stop();
    connection?.close();
    connection = null;
    router = null;
    topics = null;
  }

  return {
    get connection() {
      return connection!;
    },
    get topicManager() {
      return topics!;
    },
    get status() {
      return syncStatus;
    },
    connect,
    disconnect,
  };
}

// ── Singleton wiring ──────────────────────────────────────────────────────

let ctx = $state<SyncContext | null>(null);
let activeRoomId = $state<string | null>(null);

const { queryKey } = cache;
const GET_MESSAGES_NSID = "space.roomy.room.getMessages" as const;

/**
 * Highest `#messageDiff` seq observed on this connection. The appserver
 * stamps every diff with a single global, monotonically increasing seq
 * (InvalidationRouter.#seq), so this is one number across all rooms.
 */
let lastSeq: number | null = null;
/** Timestamp the tab was last hidden, or null while visible. */
let hiddenSince: number | null = null;

/**
 * Invalidate the active room's `getMessages` query so it refetches.
 * Called when we detect a missed diff (seq gap / server seq reset) or
 * when the tab returns from a long backgrounding — both cases where the
 * WS-authoritative cache (`staleTime: Infinity`) can't otherwise know
 * it's stale. Only the active (visible) room needs this; other rooms
 * refetch on navigation via the appserver's `sub` → `#sendRoomInvalidation`.
 */
function invalidateActiveRoomMessages() {
  const room = activeRoomId;
  if (!room) return;
  void queryClient.invalidateQueries({
    queryKey: queryKey(GET_MESSAGES_NSID, { roomId: room }),
  });
}

/**
 * On returning to the tab: nudge a stalled reconnect (the backoff timer
 * is suspended while backgrounded, so kick it immediately), and resync the
 * active room if we were hidden long enough that frames were likely
 * throttled or dropped. This covers the case where the socket stayed
 * nominally "open" so no re-sub invalidation fired, but frames were lost.
 */
function onVisibilityChange() {
  if (document.visibilityState === "visible") {
    const st = ctx?.status.state;
    if (ctx && st && st !== "connected" && st !== "connecting") {
      ctx.connect().catch(() => {});
    }
    if (hiddenSince && Date.now() - hiddenSince > 30_000) {
      invalidateActiveRoomMessages();
    }
    hiddenSince = null;
  } else {
    hiddenSince = Date.now();
  }
}

export const sync_ = {
  get ctx() {
    return ctx;
  },
  get activeRoomId() {
    return activeRoomId;
  },
  setActiveRoom(roomId: string | null) {
    activeRoomId = roomId;
  },
};

export function startSync(opts: { onLog?: (msg: string) => void } = {}) {
  if (ctx) return ctx;
  ctx = createSyncContext({
    queryClient,
    appserverDid: CONFIG.appserverDid,
    onLog: opts.onLog,
    onMessageDiff: (roomId, seq) => {
      // A seq discontinuity means we missed frames — almost always because
      // the tab was backgrounded and the WS was throttled, or the socket
      // dropped and reconnected with a gap the re-sub invalidation didn't
      // cover. `seq < lastSeq` implies the appserver's seq counter reset
      // (restart). Either way, resync the visible room.
      if (lastSeq != null && (seq > lastSeq + 1 || seq < lastSeq)) {
        invalidateActiveRoomMessages();
      }
      lastSeq = lastSeq == null ? seq : Math.max(lastSeq, seq);
      if (roomId === activeRoomId) {
        import("./mutations/update-seen").then(({ updateSeen }) => {
          updateSeen(roomId).catch(() => {});
        });
      }
    },
  });
  ctx.connect().catch((err) => {
    const msg = `Sync connect failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[sync] ${msg}`);
    opts.onLog?.(msg);
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
  return ctx;
}

export function stopSync() {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  ctx?.disconnect();
  ctx = null;
  lastSeq = null;
  hiddenSince = null;
}
