/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference lib="webworker" />

import { type Batch, type StreamIndex, type TaskPriority } from "../types";
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
  type SqliteState,
} from "./types";
import type {
  Savepoint,
  SqliteWorkerInterface,
  SqlStatement,
} from "../sqlite/types";
import { ensureEntity } from "../sqlite/materializer";
import {
  did,
  didUser,
  event,
  parseEvent,
  type DidStream,
  type DidUser,
  type Event,
} from "$lib/schema";
import { decode } from "@atcute/cbor";

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
  #authenticated = new Deferred<void>();

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

  /** Where most of the initialisation happens. Backfill the personal
   * stream from the stored cursor, then set up the other streams.
   */
  async setAuthenticated(client: Client) {
    const userDid = client.agent.did;
    if (!userDid || !didUser.allows(userDid))
      throw new Error("DID not defined on client");

    console.log("Authenticating SQLite worker with did", userDid);

    await this.sqlite
      .authenticate(didUser.assert(userDid))
      .catch((e) => console.error("Failed to authenticate sqlite worker", e));

    // try to fetch or create the personal stream
    this.setAuthState({ state: "loading" });

    const eventChannel = new AsyncChannel<Batch.Event>();

    const personalStream = await client
      .ensurePersonalStream(eventChannel)
      .catch((e) => {
        const error = { state: "error", error: e } as const;
        this.#auth = error;
        this.#status.authState = error;
        throw error;
      });

    // Ensure personal stream space entity exists
    await this.sqlite.runQuery(
      ensureEntity(personalStream.id, personalStream.id),
    );
    // Mark personal stream space as hidden
    await this.sqlite.runQuery(sql`
      insert into comp_space (entity, hidden)
      values (${personalStream.id}, 1) 
      on conflict (entity) do nothing
    `);
    // StreamConnection doesn't have access to sqlite, so we need to update the stream cursor before backfill
    personalStream.updateStreamCursor(
      await this.sqlite.getStreamCursor(personalStream.id),
    );

    this.#auth = {
      state: "authenticated",
      client,
      eventChannel,
    };
    this.#status.authState = {
      state: "authenticated",
      did: didUser.assert(userDid),
      personalStream: personalStream.id,
      clientStatus: client.status,
    };

    this.startMaterializer();

    await personalStream.backfill();

    this.#status.spaces = {
      ...this.#status.spaces,
      [personalStream.id]: "idle",
    };

    if (this.#status.authState?.state !== "authenticated")
      throw new Error("Not authenticated");

    // get streams from SQLite
    const streamsResult = await this.sqlite.runQuery<{
      id: DidStream;
      backfilled_to: StreamIndex;
    }>(sql`-- backend space list
      select e.id as id, cs.backfilled_to from entities e join comp_space cs on e.id = cs.entity
      where hidden = 0
    `);

    // pass them to the client
    const streamIdsAndCursors = (streamsResult.rows || []).map((row) => {
      return [row.id, row.backfilled_to] as const;
    });

    // set all spaces to 'loading' in reactive status
    this.#status.spaces = {
      ...Object.fromEntries(
        streamIdsAndCursors.map(([spaceId]) => [spaceId, "loading"]),
      ),
    };

    const { streams, failed } = await this.client.connect(
      personalStream,
      new Map(streamIdsAndCursors),
    );

    if (failed.length) console.warn("Some streams didn't connect", failed);
    // TODO: clean up nonexistent streams from db

    // need to reassign the whole object to trigger reactive update
    this.#status.authState = {
      clientStatus: "connected",
      did: this.#status.authState.did,
      personalStream: this.#status.authState.personalStream,
      state: "authenticated",
    };

    for (const stream of streams.values()) {
      (async () => {
        await stream.pin.backfill.completed;
        this.#status.spaces = {
          ...this.#status.spaces,
          [stream.id]: "idle",
        };
      })();
    }

    this.#authenticated.resolve();
  }

  private async startMaterializer() {
    if (this.#auth.state !== "authenticated") {
      throw new Error("Tried to handle events while unauthenticated");
    }

    console.log("Waiting for Client to be ready...");
    await this.client.connected;
    console.log("Client ready!");

    const eventChannel = this.#auth.eventChannel;

    for await (const batch of eventChannel) {
      // personal stream backfill is always high priority, other streams can be in background
      if (batch.streamId === this.client.personalStreamId) {
        console.log("materialising events batch for personal stream", batch);
        const result = await this.sqlite.materializeBatch(batch, "priority");
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
    console.log("WorkerSupervisor: Starting refreshSession");
    Client.new()
      .then((client) => {
        console.log("WorkerSupervisor: Client created successfully");
        this.setAuthenticated(client);
        client.getProfile().then((profile) => {
          this.#status.profile = profile;
        });
      })
      .catch((error) => {
        console.error("WorkerSupervisor: Could not restore session", error);
        console.error("WorkerSupervisor: Error stack:", error.stack);
        this.setAuthState({ state: "unauthenticated" });
      });
  }

  private async authenticateCallback(params: URLSearchParams) {
    this.setAuthState({ state: "loading" });
    await Client.oauthCallback(params);
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

  private async enableLogForwarding() {
    await db.kv.put({ key: "consoleForwarding", value: "true" });
    this.#config.consoleForwarding = true;
  }

  private async disableLogForwarding() {
    await db.kv.put({ key: "consoleForwarding", value: "" });
    this.#config.consoleForwarding = false;
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
        return await this.sqlite.resetLocalDatabase();
      },
      setActiveSqliteWorker: async (messagePort) => {
        console.log("Setting active SQLite worker");

        // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        await this.sqlite.setReady(
          messagePortInterface<{}, SqliteWorkerInterface>(messagePort, {}),
        );
      },
      async ping() {
        console.log("Backend: Ping received");
        return {
          timestamp: Date.now(),
        };
      },
      enableLogForwarding: () => this.enableLogForwarding(),
      disableLogForwarding: () => this.disableLogForwarding(),
      connectSpaceStream: async (streamId, idx) => {
        await this.client.connectSpaceStream(streamId, idx);
        this.#status.spaces = {
          ...this.#status.spaces,
          [streamId]: "idle",
        };
      },
      createSpaceStream: async () => {
        const streamId = await this.client.createSpaceStream();
        this.#status.spaces = {
          ...this.#status.spaces,
          [streamId]: "idle",
        };
        return streamId;
      },
      sendEvent: async (streamId: string, event: Event) => {
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
      pauseSubscription: async (_streamId) => {
        // await this.openSpacesMaterializer?.pauseSubscription(streamId);
      },
      unpauseSubscription: async (_streamId) => {
        // await this.openSpacesMaterializer?.unpauseSubscription(streamId);
      },
      resolveHandleForSpace: async (spaceId, handleAccountDid) =>
        this.client.resolveHandleForSpace(spaceId, handleAccountDid),
      resolveSpaceId: async (handleOrDid) => {
        await this.#authenticated.promise;
        return await this.client.resolveSpaceId(handleOrDid);
      },
      checkSpaceExists: async (spaceId) =>
        this.client.checkStreamExists(spaceId),
      createStreamHandleRecord: async (spaceId) => {
        await this.client.createStreamHandleRecord(spaceId);
      },
      removeStreamHandleRecord: async () => {
        await this.client.removeStreamHandleRecord();
      },
      getStreamRecord: async () => this.getStreamRecord(),
      deleteStreamRecord: async () => this.deleteStreamRecord(),
      ensurePersonalStream: async () => this.ensurePersonalStream(),
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

  async debugFetchPersonalStream(): Promise<Event[]> {
    if (this.#status.authState?.state != "authenticated") {
      throw "Not authenticated";
    }
    return this.debugFetchStream(this.#status.authState.personalStream);
  }

  async debugFetchStream(streamId: string): Promise<Event[]> {
    if (this.#status.authState?.state != "authenticated") {
      throw "Not authenticated";
    }
    const resp = await this.client.fetchEvents(streamId, 0, 1e10);

    return resp
      .map((e) => parseEvent(decode(new Uint8Array(e.payload))))
      .filter((e) => "success" in e)
      .map((e) => e.data!);
  }

  /** Testing: Get personal stream record from PDS */
  async getStreamRecord(): Promise<{ id: string } | null> {
    try {
      const response = await this.client.agent.com.atproto.repo.getRecord({
        repo: this.client.agent.did!,
        collection: CONFIG.streamNsid,
        rkey: CONFIG.streamSchemaVersion,
      });
      return response.data.value as { id: string };
    } catch (error: any) {
      if (error.message?.includes("RecordNotFound")) {
        return null;
      }
      throw error;
    }
  }

  /** Testing: Delete personal stream record from PDS */
  async deleteStreamRecord(): Promise<void> {
    try {
      await this.client.agent.api.com.atproto.repo.deleteRecord({
        repo: this.client.agent.did!,
        collection: CONFIG.streamNsid,
        rkey: CONFIG.streamSchemaVersion,
      });
    } catch (error: any) {
      // Ignore RecordNotFound errors
      if (!error.message?.includes("RecordNotFound")) {
        throw error;
      }
    }
  }

  /** Testing: Trigger personal stream creation */
  async ensurePersonalStream(): Promise<void> {
    if (this.#auth.state !== "authenticated") {
      throw new Error("Cannot ensure personal stream: not authenticated");
    }
    await this.client.ensurePersonalStream(this.#auth.eventChannel);
  }
}

class SqliteSupervisor {
  #state: SqliteState;
  liveQueries: Map<string, { port: MessagePort; statement: SqlStatement }>;

  constructor() {
    this.#state = { state: "pending", readyPromise: new Deferred() };
    this.liveQueries = new Map();
  }

  get untilReady() {
    if (this.#state.state === "pending")
      return this.#state.readyPromise.promise;
    else return undefined;
  }

  get ready() {
    return this.#state.state === "ready";
  }

  get sqliteWorker() {
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialised");
    return this.#state.sqliteWorker;
  }

  async authenticate(did: DidUser) {
    await this.untilReady;
    await this.sqliteWorker.authenticate(did);
    console.log("SQLite Worker authenticated:", did);
  }

  async setReady(workerInterface: SqliteWorkerInterface) {
    if (this.#state.state === "pending") {
      const previousSchemaVersion = await prevStream.getSchemaVersion();
      console.log(
        "SQLite Supervisor setReady got schemaVersion",
        previousSchemaVersion,
        "current",
        CONFIG.streamSchemaVersion,
      );
      if (previousSchemaVersion != CONFIG.streamSchemaVersion) {
        // Reset the local database cache when the stream schema version changes.
        // Asynchronous, but has to wait until readyPromise is resolved, so we can't await it here.
        this.resetLocalDatabase().catch(console.error);
      }

      await prevStream.setSchemaVersion(CONFIG.streamSchemaVersion);

      // Reset the local database cache when the database schema version changes
      (async () => {
        const result = await this.runQuery<{ version: string }>(
          sql`select version from roomy_schema_version`,
        );
        if (result.rows?.[0]?.version !== CONFIG.databaseSchemaVersion) {
          await this.resetLocalDatabase();
        }
      })();

      // When a new SQLite worker is created we need to make sure that we re-create all of the
      // live queries that were active on the old worker.
      for (const [id, { port, statement }] of this.liveQueries.entries()) {
        const channel = this.createLiveQueryChannel(port);
        this.createLiveQuery(id, channel.port2, statement);
      }

      this.#state.readyPromise.resolve();
    }
    this.#state = {
      state: "ready",
      sqliteWorker: workerInterface,
    };
  }

  async materializeBatch(events: Batch.Event, priority: TaskPriority) {
    await this.untilReady;
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialized.");
    return this.#state.sqliteWorker.materializeBatch(events, priority);
  }

  // Type assertion for convenience. Todo: use Zod/Arktype for sql output validation?
  async runQuery<T = unknown>(statement: SqlStatement) {
    await this.untilReady;
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialized.");
    return this.#state.sqliteWorker.runQuery(statement) as Promise<
      QueryResult<T>
    >;
  }

  async runSavepoint(savepoint: Savepoint) {
    await this.untilReady;
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
    await this.untilReady;
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialized.");
    this.liveQueries.set(id, { port, statement });
    await this.#state.sqliteWorker.createLiveQuery(id, port, statement);
  }

  async deleteLiveQuery(id: string) {
    await this.untilReady;
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialized.");
    this.liveQueries.delete(id);
    await this.#state.sqliteWorker.deleteLiveQuery(id);
  }

  async resetLocalDatabase() {
    console.warn("Resetting local database");
    await this.untilReady?.catch((error) => {
      console.error("Database did not initialise", error);
    });
    if (this.#state.state !== "ready")
      throw new Error("Sqlite worker not initialized when resetting database.");
    try {
      await this.#state.sqliteWorker.runQuery(sql`pragma writable_schema = 1`);
      await this.#state.sqliteWorker.runQuery(sql`delete from sqlite_master`);
      await this.#state.sqliteWorker.runQuery(sql`vacuum`);
      await this.#state.sqliteWorker.runQuery(sql`pragma integrity_check`);
      await personalStream.clearIdCache();
      return { done: true } as const;
    } catch (error) {
      console.error("Database reset failed", error);
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Unknown error";
      return {
        done: false,
        error: message,
      } as const;
    }
  }

  async getStreamCursor(streamId: DidStream) {
    const upToEventIdQuery = await this.runQuery<{
      backfilled_to: StreamIndex;
    }>(
      sql`select backfilled_to from comp_space where entity = ${streamId}`,
    ).catch((e) => console.warn("Error getting backfilled_to", e));

    const upToEventId =
      upToEventIdQuery &&
      upToEventIdQuery.rows?.length &&
      upToEventIdQuery.rows[0]!.backfilled_to;

    if (typeof upToEventId !== "number")
      throw new Error("Could not get backfilled_to for stream: " + streamId);

    return upToEventId as StreamIndex;
  }
}

const worker = new WorkerSupervisor();
(globalThis as any).worker = worker; // For debugging only !!
