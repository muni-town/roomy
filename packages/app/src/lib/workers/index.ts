import {
  messagePortInterface,
  reactiveChannelState,
} from "./internalMessaging";
import type {
  PeerInterface,
  PeerStatus,
  PeerClientInterface,
} from "./peer/types";
import type { SqliteStatus } from "./sqlite/types";
import { CONFIG, flags } from "../config";
import {
  JUST_LOGGED_IN_KEY,
  REDIRECT_AFTER_LOGIN_KEY,
} from "../utils/storageKeys";
import { context, trace } from "@opentelemetry/api";
import { page } from "$app/state";
import { Peer, peerStatusChannel } from "./peer/impl";
import { newUlid } from "@roomy/sdk";

// Force page reload when hot reloading this file to avoid confusion if the workers get mixed up.
if (import.meta.hot && !(window as any).__playwright) {
  import.meta.hot.accept(() => window.location.reload());
}

/** Reactive status of the shared worker "peer". */
export const peerStatus = reactiveChannelState<PeerStatus>(
  // Create message port placeholder. We will update the channel with a real one once we connect to
  // the peer instance.
  {
    onmessage() {},
    postMessage() {},
  },
  false,
);
(globalThis as any).peerStatus = peerStatus;

const workerStatusChannel = new MessageChannel();

/** Reactive status of the sqlite worker for this tab. */
export const sqliteStatus = reactiveChannelState<SqliteStatus>(
  workerStatusChannel.port1,
  false,
);

(globalThis as any).sqliteStatus = sqliteStatus;

// Initialize shared worker
const hasSharedWorker = "SharedWorker" in globalThis;
const hasWorker = "Worker" in globalThis;

const PeerWorkerConstructor =
  hasSharedWorker && flags.sharedWorker
    ? SharedWorker
    : hasWorker
      ? Worker
      : undefined;
if (!PeerWorkerConstructor)
  throw new Error("No SharedWorker or Worker constructor defined");

export const peer = tracer.startActiveSpan(
  "Wait for Peer Init",
  {},
  trace.setSpan(context.active(), globalInitSpan),
  (span) => {
    // Create a message channel for the peer communication
    const channel = new MessageChannel();

    console.log("page.params.space", page.params.space);

    // Create a peer implementation and connect it to the channel
    const peerImpl = new Peer({ sessionId: newUlid() });
    peerImpl.connectRpcClient(channel.port1);

    // Connect to the peer RPC over the channel. This pattern allows us to possibly host the peer in
    // a shared / dedicated web worker later without changing the way we communicate with it.
    const peer = messagePortInterface<PeerClientInterface, PeerInterface>({
      localName: "main",
      remoteName: "peer",
      messagePort: channel.port2,
      timeout: {
        ms: 5000,
        onTimeout: (method, reqId) => {
          if (method !== "log")
            console.warn(`RPC Timeout [peer <- main]`, {
              method,
              reqId,
            });
        },
        // Lazy loading may take longer due to materialization
        methodTimeouts: {
          lazyLoadRoom: 60000, // 60 seconds
        },
      },
      handlers: {
        async log(level, args) {
          const text = Array.isArray(args) ? args[0] : args;
          // log args should all be in format [string, object]
          const object = Array.isArray(args) && args.length > 1 ? args[1] : {};
          // in case we forget
          const remainder =
            Array.isArray(args) && args.length > 2 ? args.slice(2) : [];
          const prefixedArgs = ["[BW] " + text, { ...object }, ...remainder]; // Peer Worker
          console[level](...prefixedArgs);
        },
        async setSessionId(id) {
          faro.api.setSession({
            id,
            attributes: { isSampled: "true" },
          });
          console.log("[Peer Status] updating channel with session", id);
          peerStatus.updateChannel(peerStatusChannel(id));
        },
        async initFinished({ userDid }) {
          globalInitSpan.setAttribute("userDid", userDid);
          globalInitSpan.end();
        },
      },
    });

    (globalThis as any).peer = peer;
    (globalThis as any).CONFIG = CONFIG;

    console.debug("(init.1) Peer worker loaded");

    // Start a sqlite worker for this tab.
    const sqliteWorkerChannel = new MessageChannel();
    peer.connectRpcClient(sqliteWorkerChannel.port1);
    const sqliteWorker = new Worker(
      new URL("./sqlite/worker.ts", import.meta.url),
      {
        name: "roomy-sqlite-worker",
        type: "module",
      },
    );

    console.debug("(init.2) Sqlite worker loaded");

    sqliteWorker.postMessage(
      {
        peerPort: sqliteWorkerChannel.port2,
        statusPort: workerStatusChannel.port2,
        dbName: "temp",
        sessionId: faro.api.getSession()!.id,
      },
      [sqliteWorkerChannel.port2, workerStatusChannel.port2],
    );

    // Use window.location instead of page.route.id because SvelteKit's
    // page state isn't resolved yet at module init time, causing the guard
    // to fail and triggering scope-check redirects on the callback page.
    if (!window.location.pathname.includes("/oauth/callback")) {
      // Skip scope check if user just completed login (prevents infinite redirect loop).
      // The flag is set by the OAuth callback page and cleared by +layout.svelte
      // after caching the user's profile. TTL prevents a stale flag from permanently
      // disabling scope checks (e.g., if the user closed the tab mid-flow).
      const JUST_LOGGED_IN_TTL_MS = 60_000;
      const justLoggedInAt = localStorage.getItem(JUST_LOGGED_IN_KEY);
      const skipScopeCheck =
        justLoggedInAt !== null &&
        Date.now() - Number(justLoggedInAt) < JUST_LOGGED_IN_TTL_MS;

      peer
        .initializePeer(
          undefined,
          skipScopeCheck ? { skipScopeCheck: true } : undefined,
        )
        .then((result) => {
          if (result.redirectUrl) {
            // Set just-logged-in BEFORE redirect so the callback page's
            // module init skips the scope check (page.route.id guard is
            // unreliable at module load time).
            localStorage.setItem(JUST_LOGGED_IN_KEY, Date.now().toString());
            localStorage.setItem(
              REDIRECT_AFTER_LOGIN_KEY,
              window.location.pathname || "/home",
            );
            window.location.href = result.redirectUrl;
          }
        })
        .catch((e) => {
          console.error("Peer initialization failed", e);
        });
    }

    span.end();

    return peer;
  },
);

export function getPersonalSpaceId() {
  return peerStatus.roomyState?.state === "connected" ||
    peerStatus.roomyState?.state === "materializingPersonalSpace"
    ? peerStatus.roomyState.personalSpace
    : undefined;
}

// for running in console REPL
(window as any).debugWorkers = {
  async pingPeer() {
    try {
      const result = await peer.ping();
      console.log("Main thread: Peer ping result", result);
      return result;
    } catch (error) {
      console.error("Main thread: Peer ping failed", error);
      throw error;
    }
  },

  async testSqliteConnection() {
    try {
      const result = await peer.runQuery({ sql: "SELECT 1 as test" });
      console.log("Main thread: SQLite test query result", result);
      return result;
    } catch (error) {
      console.error("Main thread: SQLite test query failed", error);
      throw error;
    }
  },

  logWorkerStatus() {
    console.log("📊 [peerStatus] Current state:", peerStatus.current);
    console.log("🗃️ [sqliteStatus] Current state:", sqliteStatus.current);
  },
};
