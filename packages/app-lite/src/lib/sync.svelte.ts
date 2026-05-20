/**
 * Wraps SDK sync primitives (SyncConnection / SyncRouter / TopicManager)
 * with app-lite's QueryClient cache adapter + ticket fetch.
 */

import { sync, transport } from "@roomy-space/sdk";
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
const { agentProcedure, resolveAppserverWsOrigin } = transport;

export interface SyncContext {
  connect: () => Promise<void>;
  disconnect: () => void;
  readonly connection: SyncConnectionLike;
  readonly topicManager: TopicManagerLike;
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

  function log(msg: string) {
    console.log(`[sync] ${msg}`);
    onLog?.(msg);
  }

  async function fetchTicket(): Promise<string> {
    log("Fetching WS connection ticket…");
    try {
      const res = await agentProcedure(
        px(),
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

    const wsOrigin = await resolveAppserverWsOrigin(appserverDid);
    log(`Resolved WS origin: ${wsOrigin}`);

    connection = new SyncConnection({
      wsUrl: `${wsOrigin}/xrpc/space.roomy.sync.subscribe`,
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
      } else if (t === "#invalidate") {
        const body = frame.body as { nsid?: string; params?: unknown };
        log(
          `[invalidate] nsid=${body.nsid} params=${JSON.stringify(body.params)}`,
        );
      }
    });

    connection.onStatusChange((status) => {
      log(`[status] ${JSON.stringify(status)}`);
    });

    connection.onError((err) => {
      log(`[error] ${err instanceof Error ? err.message : String(err)}`);
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
    connect,
    disconnect,
  };
}

// ── Singleton wiring ──────────────────────────────────────────────────────

let ctx = $state<SyncContext | null>(null);
let activeRoomId = $state<string | null>(null);

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
    onMessageDiff: (roomId) => {
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
  return ctx;
}

export function stopSync() {
  ctx?.disconnect();
  ctx = null;
}
