/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference lib="webworker" />

import { type Batch, type EventType, type StreamHashId } from "../types";
import {
  messagePortInterface,
  reactiveWorkerState,
  type MessagePortApi,
} from "../workerMessaging";
import { sql } from "$lib/utils/sqlTemplate";
import { CONFIG } from "$lib/config";
import { AsyncChannel } from "../asyncChannel";
import { db, personalStream, prevStream } from "../idb";
import { Client } from "./client";
import { Deferred } from "$lib/utils/deferred";
import type { QueryResult } from "../sqlite/setup";
import {
  type WorkerConfig,
  type AuthState,
  type ConnectionState,
  type BackendStatus,
  type BackendInterface,
  type ConsoleInterface,
  consoleLogLevels,
} from "./types";
import type {
  Savepoint,
  SqliteWorkerInterface,
  SqlStatement,
} from "../sqlite/types";
import { isDid, type Did } from "@atproto/api";

// TODO: figure out why refreshing one tab appears to cause a re-render of the spaces list live
// query in the other tab.

/**
 * Check whether or not we are executing in a shared worker.
 *
 * On platforms like Android chrome where SharedWorkers are not available this script will run as a
 * dedicated worker instead of a shared worker.
 * */
const isSharedWorker = "SharedWorkerGlobalScope" in globalThis;

/**
 * SharedWorker logs are not accessible in all browsers.
 *
 * For Chrome, go to chrome://inspect/#workers and click 'inspect' under roomy-backend
 * For browsers that don't have this feature, call this.debugWorkers.enableLogForwarding()
 * from the main thread to see worker logs there
 * */

/**
 * Singleton for supervising authentication, subscriptions and materialisation
 * */
class WorkerSupervisor {
  #config: WorkerConfig;
  #sqlite: SqliteSupervisor;

  #status: Partial<BackendStatus>;
  #auth: AuthState;
  #connection: ConnectionState; // tabs connected to shared worker

  constructor() {
    this.#config = {
      consoleForwarding: import.meta.env.SHARED_WORKER_LOG_FORWARDING || true,
    };
    this.loadStoredConfig();

    console.log("Starting Roomy WorkerSupervisor", this.#config);

    this.#sqlite = new SqliteSupervisor();
    this.#status = reactiveWorkerState<BackendStatus>(
      new BroadcastChannel("backend-status"),
      true,
    );
    this.#auth = { state: "loading" };
    this.#status.authState = this.#auth; // in general prefer setAuthState
    this.#connection = { ports: new WeakMap(), count: 0 };
    this.connectRPC();

    this.refreshSession();
  }

  setAuthenticated(client: Client) {
    // 'authenticated' reactive state has did and personalStream, not client
    const did = client.agent.did;
    const statementChannel = new AsyncChannel<{
      sqlStatements: SqlStatement[];
      latestEvent: number;
    }>();
    if (!did || !isDid(did)) throw new Error("DID not defined on client");

    console.log("Authenticating SQLite worker with did", did);

    this.sqlite
      .authenticate(did)
      .then(() => {
        console.log("Authenticated Sqlite worker");
        // try to fetch or create the personal stream
        const loading = { state: "loading" } as const;
        this.#auth = loading;
        this.#status.authState = loading;

        client
          .ensurePersonalStream(did)
          .then((personalStream) => {
            console.log("Got personalStreamId", personalStream);
            client.ready.then((readyState) => {
              this.#auth = {
                state: "authenticated",
                client,
                eventChannel: readyState.eventChannel,
                statementChannel,
              };
              this.#status.authState = {
                state: "authenticated",
                did,
                personalStream,
              };
              this.runMaterializer();

              client.personalStreamFetched.promise.then(() => {
                this.loadStreams();
              });
            });
          })
          .catch((e) => {
            const error = { state: "error", error: e } as const;
            this.#auth = error;
            this.#status.authState = error;
          });
      })
      .catch((e) => console.error("Failed to authenticate sqlite worker", e));
  }

  private async runMaterializer() {
    if (this.#auth.state !== "authenticated") {
      throw new Error("Tried to handle events while unauthenticated");
    }

    console.log("Waiting for Client to connect");

    await this.client.ready;

    console.log("Client connected!");
    const eventChannel = await this.client.getEventChannel();

    for await (const batch of eventChannel) {
      // personal stream backfill is always high priority, other streams can be in background
      if (batch.streamId === this.client.personalStreamId) {
        console.log("materialising events batch for personal stream", batch);
        const result = await this.sqlite.materializeBatch(batch, "normal");
        console.log("result", result);
      } else {
        console.log("materialising events batch for space stream", batch);
        const result = await this.sqlite.materializeBatch(
          batch,
          batch.priority,
        );
        console.log("result", result);
      }
    }
  }

  private setAuthState(state: AuthState) {
    if (state.state !== "authenticated") {
      this.#auth = state;
      this.#status.authState = state;
      return;
    } else {
      this.setAuthenticated(state.client);
    }
  }

  private loadStoredConfig() {
    db.kv
      .get("consoleForwarding")
      .then((pref) => (this.#config.consoleForwarding = !!pref?.value));
  }

  private connectRPC() {
    if (isSharedWorker) {
      (globalThis as any).onconnect = async ({
        ports: [port],
      }: {
        ports: [MessagePort];
      }) => {
        this.connectMessagePort(port);
      };
    } else {
      this.connectMessagePort(globalThis);
    }
  }

  private connectMessagePort(port: MessagePortApi) {
    // Prevent duplicate connections - only connect once per port
    if (this.#connection.ports.has(port)) {
      const existingId = this.#connection.ports.get(port);
      console.log(
        `SharedWorker: Port already connected (ID: ${existingId}), skipping duplicate connection`,
      );
      return;
    }

    const connectionId = `conn-${++this.#connection.count}`;
    this.#connection.ports.set(port, connectionId);

    // Log connection BEFORE setting up console forwarding to avoid broadcast duplication
    console.log(
      `SharedWorker backend connected (ID: ${connectionId}, total: ${this.#connection.count})`,
    );

    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    const consoleInterface = messagePortInterface<
      BackendInterface,
      ConsoleInterface
    >(port, this.getBackendInterface());

    // Set up console forwarding to main thread for debugging
    // This intercepts console.log/warn/error/info/debug calls in the SharedWorker
    // and forwards them to the main thread with a [SharedWorker] prefix.
    // This is essential for debugging on Safari where SharedWorker console
    // output is not directly visible in developer tools.
    for (const level of consoleLogLevels) {
      const normalLog = globalThis.console[level];
      globalThis.console[level] = (...args) => {
        normalLog(...args);
        if (worker.consoleForwarding) {
          consoleInterface.log(level, args);
        }
      };
    }
  }

  private async refreshSession() {
    Client.new()
      .then((client) => {
        this.setAuthenticated(client);
        client.getProfile().then((profile) => {
          this.#status.profile = profile;
        });
      })
      .catch((error) => {
        console.warn("Could not restore session", error);
        this.setAuthState({ state: "unauthenticated" });
      });
  }

  private async authenticateCallback(params: URLSearchParams) {
    this.setAuthState({ state: "loading" });
    await Client.oauthCallback(params);
  }

  private get authenticated() {
    return this.#auth.state === "authenticated";
  }

  private get consoleForwarding() {
    return this.#config.consoleForwarding;
  }

  private get client() {
    if (this.#auth.state === "authenticated") {
      return this.#auth.client;
    } else {
      throw new Error("Not authenticated");
    }
  }

  private get sqlite() {
    return this.#sqlite;
  }

  private get profile() {
    return this.#status.profile;
  }
  private set profile(profile) {
    this.#status.profile = profile;
  }

  private async enableLogForwarding() {
    await db.kv.put({ key: "consoleForwarding", value: "true" });
    this.#config.consoleForwarding = true;
  }

  private async disableLogForwarding() {
    await db.kv.put({ key: "consoleForwarding", value: "" });
    this.#config.consoleForwarding = false;
  }

  private async loadStreams() {
    // get streams from SQLite
    const result = await this.sqlite.runQuery<{
      id: StreamHashId;
    }>(sql`-- backend space list
      select id(e.id) as id from entities e join comp_space on e.id = comp_space.entity
      where hidden = 0
    `);

    console.log("spaces...", result);
    // pass them to the client
    const streams = new Set(result.rows?.map((row) => row.id) || []);
    await this.client.connect(streams);
  }

  private getBackendInterface(): BackendInterface {
    return {
      login: async (handle) => Client.login(handle),
      oauthCallback: async (paramsStr) => {
        const params = new URLSearchParams(paramsStr);
        await this.authenticateCallback(params);
      },
      logout: async () => this.logout(),
      getProfile: async (did) => this.client.getProfile(did),
      runQuery: async (statement) => {
        await this.sqlite.untilReady;
        return this.sqlite.runQuery(statement);
      },
      createLiveQuery: async (id, port, statement) => {
        await this.sqlite.untilReady;

        const channel = this.sqlite.createLiveQueryChannel(port);
        navigator.locks.request(id, async () => {
          // When we obtain a lock to the query ID, that means that the query is no longer in
          // use and we can delete it.
          await this.sqlite.deleteLiveQuery(id);
        });
        return this.sqlite.createLiveQuery(id, channel.port2, statement);
      },
      dangerousCompletelyDestroyDatabase: async ({ yesIAmSure }) => {
        if (!yesIAmSure) throw "You need to be sure";
        this.sqlite.resetLocalDatabase();
      },
      setActiveSqliteWorker: async (messagePort) => {
        console.log("Setting active SQLite worker");

        // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        await this.sqlite.setReady(
          messagePortInterface<{}, SqliteWorkerInterface>(messagePort, {}),
        );

        // When a new SQLite worker is created we need to make sure that we re-create all of the
        // live queries that were active on the old worker.
        for (const [
          id,
          { port, statement },
        ] of this.sqlite.liveQueries.entries()) {
          const channel = this.sqlite.createLiveQueryChannel(port);
          this.sqlite.createLiveQuery(id, channel.port2, statement);
        }
      },
      async ping() {
        console.log("Backend: Ping received");
        return {
          timestamp: Date.now(),
        };
      },
      enableLogForwarding: () => this.enableLogForwarding(),
      disableLogForwarding: () => this.disableLogForwarding(),
      createStream: async (ulid, moduleId, moduleUrl, params) =>
        this.client.createStream(ulid, moduleId, moduleUrl, params),
      sendEvent: async (streamId: string, event: EventType) => {
        await this.client.sendEvent(streamId, event);
      },
      sendEventBatch: async (streamId, payloads) => {
        await this.client.sendEventBatch(streamId, payloads);
      },
      fetchEvents: async (streamId, offset, limit) =>
        this.client.fetchEvents(streamId, offset, limit),
      previewSpace: async (_streamId) => {
        await this.sqlite.untilReady;
        // TODO: Replace with partial loads of space.

        return new Promise(() => {
          name: "test";
        });
      },
      uploadToPds: async (bytes, opts) => {
        return this.client.uploadToPDS(bytes, opts);
      },
      addClient: async (port) => this.connectMessagePort(port),
      pauseSubscription: async (streamId) => {
        // await this.openSpacesMaterializer?.pauseSubscription(streamId);
      },
      unpauseSubscription: async (streamId) => {
        // await this.openSpacesMaterializer?.unpauseSubscription(streamId);
      },
      resolveHandleForSpace: async (spaceId, handleAccountDid) =>
        this.client.resolveHandleForSpace(spaceId, handleAccountDid),
      resolveSpaceFromHandleOrDid: async (handleOrDid) =>
        this.client.resolveSpaceFromHandleOrDid(handleOrDid),
      createStreamHandleRecord: async (spaceId) => {
        await this.client.createStreamHandleRecord(spaceId);
      },
      removeStreamHandleRecord: async () => {
        await this.client.removeStreamHandleRecord();
      },
    };
  }

  private logout() {
    if (this.#auth.state === "authenticated") {
      this.#auth.client.logout();
      this.#auth = { state: "unauthenticated" };
    } else {
      console.warn("Already logged out");
    }
  }
}

type SqlitePending = {
  state: "pending";
};

type SqliteReady = {
  state: "ready";
  sqliteWorker: SqliteWorkerInterface;
};

type SqliteState = SqlitePending | SqliteReady;

class SqliteSupervisor {
  #state: SqliteState;
  #ready = new Deferred();
  liveQueries: Map<string, { port: MessagePort; statement: SqlStatement }>;

  constructor() {
    this.#state = { state: "pending" };
    this.liveQueries = new Map();
  }

  get untilReady() {
    return this.#ready.promise;
  }

  get ready() {
    return this.#state.state === "ready";
  }

  get sqliteWorker() {
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialised");
    return this.#state.sqliteWorker;
  }

  async authenticate(did: Did) {
    await this.#ready.promise;
    return await this.sqliteWorker.authenticate(did);
  }

  async setReady(proxy: SqliteWorkerInterface) {
    const previousSchemaVersion = await prevStream.getSchemaVersion();
    console.log(
      "SQLite Supervisor setReady got schemaVersion",
      previousSchemaVersion,
    );

    this.#state = {
      state: "ready",
      sqliteWorker: proxy,
    };
    this.#ready.resolve();

    if (previousSchemaVersion != CONFIG.streamSchemaVersion) {
      // Reset the local database cache when the schema version changes.
      await this.resetLocalDatabase();
    }

    await prevStream.setSchemaVersion(CONFIG.streamSchemaVersion);
  }

  async materializeBatch(
    events: Batch.Event,
    priority: "normal" | "background",
  ) {
    console.log("SQLite Supervisor materializeBatch");
    await this.untilReady;
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialized.");
    console.log(
      "SQLite Supervisor calling proxy materializeBatch with",
      events,
    );
    return this.#state.sqliteWorker.materializeBatch(events, priority);
  }

  // Type assertion for convenience. Todo: use Zod/Arktype for sql output validation?
  async runQuery<T = unknown>(statement: SqlStatement) {
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialized.");
    console.log("runQuery", statement);
    return this.#state.sqliteWorker.runQuery(statement) as Promise<
      QueryResult<T>
    >;
  }

  async runSavepoint(savepoint: Savepoint) {
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialized.");
    return this.#state.sqliteWorker.runSavepoint(savepoint);
  }

  createLiveQueryChannel(port: MessagePort) {
    const channel = new MessageChannel();
    channel.port1.onmessage = (ev) => {
      port.postMessage(ev.data);
    };
    return channel;
  }

  async createLiveQuery(
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ) {
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialized.");
    this.liveQueries.set(id, { port, statement });
    await this.#state.sqliteWorker.createLiveQuery(id, port, statement);
  }

  async deleteLiveQuery(id: string) {
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialized.");
    this.liveQueries.delete(id);
    await this.#state.sqliteWorker.deleteLiveQuery(id);
  }

  async resetLocalDatabase() {
    console.warn("Resetting local database");
    await this.untilReady.catch((error) => {
      console.error("Database did not initialise", error);
    });
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialized when resetting database.");
    await this.#state.sqliteWorker.runQuery(sql`pragma writable_schema = 1`);
    await this.#state.sqliteWorker.runQuery(sql`delete from sqlite_master`);
    await this.#state.sqliteWorker.runQuery(sql`vacuum`);
    await this.#state.sqliteWorker.runQuery(sql`pragma integrity_check`);
    await db.streamCursors.clear();
    await personalStream.clearIdCache();
  }
}

const worker = new WorkerSupervisor();
(globalThis as any).worker = worker; // For debugging only !!
