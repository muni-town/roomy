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
import { db, prevStream } from "../idb";
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
  type RoomyState,
} from "./types";
import type {
  Savepoint,
  SqliteWorkerInterface,
  SqlStatement,
} from "../sqlite/types";
import {
  ConnectedSpace,
  Did,
  ensureEntity,
  modules,
  parseEvents,
  RoomyClient,
  withTimeoutCallback,
  type DecodedStreamEvent,
  type EncodedStreamEvent,
  type EventCallback,
} from "@roomy/sdk";
import {
  AsyncChannel,
  UserDid,
  parseEvent,
  type StreamDid,
  type Event,
  newUlid,
  Ulid,
} from "@roomy/sdk";
import { decode, encode } from "@atcute/cbor";
import { initializeFaro } from "$lib/otel";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { logMaterializationResult } from "../materializationLogging";
import { createOauthClient, oauthDb } from "./oauth";
import { Agent, CredentialSession } from "@atproto/api";
import { requestLock, locksEnabled } from "$lib/workers/locks";
import { lexicons } from "$lib/lexicons";
import type { SessionManager } from "@atproto/api/dist/session-manager";

const sessionId = newUlid();

initializeFaro({ worker: "backend" });
faro.api.setSession({ id: sessionId, attributes: { isSampled: "true" } });

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

  #auth: AuthState;
  #roomy: RoomyState;
  #status: Partial<BackendStatus>;

  #connection: ConnectionState; // tabs connected to shared worker
  #authenticated = new Deferred<void>();
  #connectedPersonalSpace = new Deferred<
    Extract<RoomyState, { state: "materializingPersonalSpace" }>
  >();
  #connected = new Deferred<Extract<RoomyState, { state: "connected" }>>();

  /* To get the result of a materialised batch, create and await a Promise
  setting the resolver against the Batch ID in this Map */
  #batchResolvers: Map<
    Ulid,
    (value: Batch.Statement | Batch.ApplyResult) => void
  > = new Map();

  constructor() {
    let [initSpan, ctx] = tracer.startActiveSpan(
      "Construct Backend",
      (span) => [span, context.active()] as const,
    );

    // This span gives us a starting placeholder for the Init Backend span in case something gets
    // stuck and we need to look for an incomplete backend initialization trace.
    tracer.startActiveSpan("Start Init Backend", {}, ctx, (span) => span.end());

    this.#config = {
      consoleForwarding: import.meta.env.SHARED_WORKER_LOG_FORWARDING || true,
    };
    this.loadStoredConfig();

    console.info("Starting Roomy WorkerSupervisor", this.#config);

    this.#sqlite = new SqliteSupervisor();
    this.#status = reactiveWorkerState<BackendStatus>(
      new BroadcastChannel("backend-status"),
      true,
    );

    this.#auth = { state: "loading" };
    this.#status.authState = this.#auth;
    this.#roomy = { state: "disconnected" };
    this.#status.roomyState = this.#roomy;

    this.#connection = { ports: new WeakMap(), count: 0 };

    this.connectRPC();

    initSpan.end();
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

  private getBackendInterface(): BackendInterface {
    return {
      getSessionId: async () => {
        return sessionId;
      },
      setSpaceHandle: (spaceDid, handle) => {
        if (this.#roomy.state !== "connected") throw new Error("Not connected");
        return this.#roomy.client.setHandle(spaceDid, handle);
      },
      getSpaceInfo: (streamDid) => {
        if (this.#roomy.state !== "connected") throw new Error("Not connected");
        return this.#roomy.client.getSpaceInfo(streamDid);
      },
      login: async (handle) => this.login(handle),
      initialize: async (paramsStr) => {
        return await this.initialize(paramsStr);
      },
      logout: async () => await this.logout(),
      getProfile: async (did) => {
        await this.#connectedPersonalSpace.promise;
        return this.client.getProfile(did);
      },
      runQuery: async (statement) => {
        return this.sqlite.runQuery(statement);
      },
      createLiveQuery: async (id, port, statement) => {
        await this.sqlite.untilReady;

        const channel = this.sqlite.createLiveQueryChannel(port);
        // When SharedWorker is enabled, use lock acquisition as a signal that the query
        // is no longer in use. When disabled, cleanup is handled by explicit deleteLiveQuery calls.
        if (locksEnabled()) {
          requestLock(id, async () => {
            // When we obtain a lock to the query ID, that means that the query is no longer in
            // use and we can delete it.
            await this.sqlite.deleteLiveQuery(id);
          });
        }
        return this.sqlite.createLiveQuery(id, channel.port2, statement);
      },
      deleteLiveQuery: async (id) => {
        await this.sqlite.untilReady;
        await this.sqlite.deleteLiveQuery(id);
      },
      dangerousCompletelyDestroyDatabase: async ({ yesIAmSure }) => {
        if (!yesIAmSure) throw "You need to be sure";
        return await this.sqlite.sqliteWorker.resetLocalDatabase();
      },
      setActiveSqliteWorker: async (messagePort) => {
        // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        await this.sqlite.setReady(
          messagePortInterface<{}, SqliteWorkerInterface>({
            localName: "backend",
            remoteName: "sqlite",
            messagePort,
            handlers: {},
          }),
        );
      },
      async ping() {
        console.info("Backend: Ping received");
        return {
          timestamp: Date.now(),
        };
      },
      clientConnected: async () => {
        await this.#authenticated.promise;
        await this.#connected.promise;
      },
      enableLogForwarding: () => this.enableLogForwarding(),
      disableLogForwarding: () => this.disableLogForwarding(),
      connectSpaceStream: async (streamId, idx) => {
        await this.connectSpaceStream(streamId, idx);
      },
      createSpaceStream: async () => {
        const streamId = await this.createSpaceStream();
        this.#status.spaces = {
          ...this.#status.spaces,
          [streamId]: "idle",
        };
        return streamId;
      },
      sendEvent: async (streamId: string, event: Event) => {
        // Create a promise that resolves when the event is materialized
        const materialized = new Promise<void>((resolve) => {
          this.#batchResolvers.set(event.id, () => resolve());
        });

        await this.client.leaf.sendEvent(streamId, encode(event));
        await materialized;
      },
      sendEventBatch: async (streamId, payloads) => {
        // Create promises for each event that resolve when materialized
        const materializedPromises = payloads.map(
          (event) =>
            new Promise<void>((resolve) => {
              this.#batchResolvers.set(event.id, () => resolve());
            }),
        );

        await this.sendEventBatch(streamId, payloads);
        await Promise.all(materializedPromises);
      },
      fetchEvents: async (streamId, offset, limit) =>
        this.fetchEvents(streamId, offset, limit),
      lazyLoadRoom: async (streamId, roomId, end) => {
        await this.sqlite.untilReady;
        return await this.lazyLoadRoom(streamId, roomId, end);
      },
      fetchLinks: async (streamId, start, limit, room) =>
        this.fetchLinks(streamId, start, limit, room),
      uploadToPds: async (bytes, opts) => {
        return this.client.uploadBlob(bytes, opts);
      },
      addClient: async (port) => this.connectMessagePort(port),
      pauseSubscription: async (_streamId) => {
        // await this.openSpacesMaterializer?.pauseSubscription(streamId);
      },
      unpauseSubscription: async (_streamId) => {
        // await this.openSpacesMaterializer?.unpauseSubscription(streamId);
      },
      resolveHandleForSpace: async (spaceId) =>
        this.client.resolveHandleFromSpaceId(spaceId),
      resolveSpaceId: async (handleOrDid) => {
        await this.#connected.promise;
        const resp =
          await this.client.resolveSpaceIdFromDidOrHandle(handleOrDid);
        return {
          spaceId: resp.spaceDid,
          handle: resp.handle,
        };
      },
      checkSpaceExists: async (spaceId) =>
        // TODO: this isn't the best way to check whether a space exists, but right now we actually
        // don't have a way check for stream existence in the API so it's a close enough
        // approximation.
        !!(await this.client.getSpaceInfo(spaceId))?.name,
      setProfileSpace: async (spaceId) => {
        await this.client.setProfileSpace(spaceId);
      },
      getProfileSpace: async () => {
        await this.#connected.promise;
        return this.client.resolveProfileSpaceFromUserDid(
          this.client.agent.assertDid as UserDid,
        );
      },
      getStreamRecord: async () => this.getStreamRecord(),
      deleteStreamRecord: async () => this.deleteStreamRecord(),
      ensurePersonalStream: async () => this.ensurePersonalStream(),
      connectPendingSpaces: async () => {
        await this.sqlite.sqliteWorker.connectPendingSpaces();
      },
      getMembers: async (spaceDid) => {
        await this.#connected.promise;
        // TODO: we should move this logic to the SDK
        const resp = await this.client.leaf.query(spaceDid, {
          name: "members",
          params: {},
        });

        return Promise.all(
          resp
            .flatMap((x) => {
              if (x.user_id?.$type == "muni.town.sqliteValue.text") {
                return [Did.assert(x.user_id.value)];
              }
              return [];
            })
            .map(async (did) => {
              const profile = await this.client.getProfile(did);
              return {
                did,
                avatar: profile?.avatar,
                name: profile?.displayName,
                handle: profile?.handle,
              };
            }),
        );
      },
    };
  }

  private connectMessagePort(port: MessagePortApi) {
    // Prevent duplicate connections - only connect once per port
    if (this.#connection.ports.has(port)) {
      const existingId = this.#connection.ports.get(port);
      console.debug(
        `SharedWorker: Port already connected (ID: ${existingId}), skipping duplicate connection`,
      );
      return;
    }

    const connectionId = `conn-${++this.#connection.count}`;
    this.#connection.ports.set(port, connectionId);

    // Log connection BEFORE setting up console forwarding to avoid broadcast duplication
    console.debug("(init.1) SharedWorker backend connected", {
      id: connectionId,
      total: this.#connection.count,
    });

    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    const consoleInterface = messagePortInterface<
      BackendInterface,
      ConsoleInterface
    >({
      localName: "backend",
      remoteName: "main",
      messagePort: port,
      handlers: this.getBackendInterface(),
    });

    consoleInterface.setSessionId(sessionId);

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
          try {
            consoleInterface.log(level, args);
          } catch (e) {
            consoleInterface.log(
              level,
              "Failed to forward log, probably due to trying to log uncloneable object",
            );
          }
        }
      };
    }

    this.#connected.promise.then((roomyState) => {
      // Tell the main thread that initialization is finished.
      consoleInterface.initFinished({
        userDid: roomyState.client.agent.assertDid,
      });
    });
  }

  private async initialize(paramsStr?: string): Promise<{ did?: string }> {
    let [initSpan, ctx] = tracer.startActiveSpan(
      "Init Backend",
      (span) => [span, context.active()] as const,
    );
    console.debug("Initialising Backend Worker", { paramsStr });
    return context.with(ctx, async () => {
      // attempt to authenticate
      const params = paramsStr ? new URLSearchParams(paramsStr) : undefined;
      const session = await this.authenticate(params);

      tracer.startActiveSpan(
        "Wait Until Authenticated",
        {},
        ctx,
        (waitSpan) => {
          this.#authenticated.promise.then(() => {
            waitSpan.end(), initSpan.end();
          });
        },
      );

      if (!session) {
        console.info("Not authenticated");
        this.#auth = { state: "unauthenticated" };
        this.#status.authState = this.#auth;
        return {};
      }

      if (!session.did) throw new Error("No DID on session"); // not sure why this would happen

      // user is authenticated
      await db.kv.put({ key: "did", value: session.did });
      this.#auth = { state: "authenticated", session };
      this.#status.authState = {
        state: "authenticated",
        did: session.did as UserDid,
      };
      faro.api.setSession({
        id: faro.api.getSession()?.id,
        attributes: { isSampled: "true", did: session.did },
      });

      console.debug("Session restored successfully");

      // init with session
      context.with(ctx, () => this.initBackendWithSession(session));

      return { did: session.did };
    });
  }

  private async authenticate(
    params?: URLSearchParams,
  ): Promise<SessionManager | null> {
    const oauth = await createOauthClient();

    if (params) {
      // oauth callback
      const [span, _ctx] = tracer.startActiveSpan(
        "Create Session at OAuth Callback",
        {},
        (span) => [span, context.active()] as const,
      );

      try {
        const response = await oauth.callback(params);
        span.end();
        return response.session;
      } catch (e) {
        console.warn("OAuth callback failed", e);
        span.end();
        return null;
      }
    } else {
      // refresh session
      const [span, ctx] = tracer.startActiveSpan(
        "Refresh Session",
        {},
        (span) => [span, context.active()] as const,
      );
      if (CONFIG.testingAppPassword && CONFIG.testingHandle) {
        // authenticate using app password (testing only)
        console.debug("Using app password authentication for testing");
        const session = new CredentialSession(new URL("https://bsky.social"));
        try {
          await session.login({
            identifier: CONFIG.testingHandle,
            password: CONFIG.testingAppPassword,
          });
          span.end();
          this.#authenticated.resolve();
          return session;
        } catch (error) {
          console.error("loginWithAppPassword: Login failed", error);
          span.end();
          throw error;
        }
      } else {
        // if there's a stored DID and no session yet, try to restore the session
        const didEntry = await db.kv.get("did");
        if (!didEntry?.value) return null;

        const session = await tracer.startActiveSpan(
          "Restore Oauth Session",
          {},
          ctx,
          (span) =>
            oauth.restore(didEntry.value).catch((e) => {
              console.warn("Restore session failed", e);
              span.end();
              return null;
            }),
        );
        this.#authenticated.resolve();
        span.end();
        return session;
      }
    }
  }

  /** Where most of the initialisation happens. Backfill the personal
   * stream from the stored cursor, then set up the other streams.
   */
  async initBackendWithSession(session: SessionManager) {
    const [span, ctx] = tracer.startActiveSpan(
      "Init Backend With Client",
      (span) => [span, context.active()] as const,
    );

    // create the Roomy client
    const eventHandlers = {
      onConnect: () => console.debug("BW (restored): connected"),
      onDisconnect: () => console.debug("BW (restored): disconnected"),
    };

    const agent = new Agent(session);
    lexicons.forEach((l) => agent.lex.add(l as any));

    this.#roomy = { state: "connectingToServer" };
    this.#status.roomyState = this.#roomy;

    const roomy = await context.bind(ctx, RoomyClient.create)(
      {
        agent,
        leafUrl: CONFIG.leafUrl,
        leafDid: CONFIG.leafServerDid,
        profileSpaceNsid: CONFIG.profileSpaceNsid,
        spaceNsid: CONFIG.streamNsid,
        plcDirectory: CONFIG.plcDirectory,
      },
      eventHandlers,
    );

    // fetch profile in advance (don't await)
    tracer.startActiveSpan("Fetch Profile", {}, ctx, (span) => {
      roomy
        .getProfile()
        .then((profile) => {
          this.#status.profile = profile;
        })
        .finally(() => span.end());
    });

    console.debug("Looking for personal stream id with", {
      rkey: CONFIG.streamSchemaVersion,
    });

    // Open connection to personal space
    const personalSpace = await roomy.connectPersonalSpace(
      CONFIG.streamSchemaVersion,
    );

    const eventChannel = new AsyncChannel<Batch.Events>();

    const callback = this.#createEventCallback(
      eventChannel,
      personalSpace.streamDid,
      // After each personal stream batch is materialized, connect to any new spaces
      async () => this.sqlite.sqliteWorker.connectPendingSpaces(),
    );

    // backfill entire personal space
    await personalSpace.subscribe(callback);

    // Ensure personal stream space entity exists
    await this.sqlite.runQuery(
      ensureEntity(personalSpace.streamDid, personalSpace.streamDid),
    );

    // Mark personal stream space as hidden
    await this.sqlite.runQuery(sql`
      insert into comp_space (entity, hidden)
      values (${personalSpace.streamDid}, 1) 
      on conflict (entity) do nothing
    `);

    this.#roomy = {
      state: "materializingPersonalSpace",
      client: roomy,
      personalSpace,
      eventChannel,
      spaces: new Map(),
    };
    this.#status.roomyState = {
      state: "materializingPersonalSpace",
      personalSpace: personalSpace.streamDid,
    };
    this.#connectedPersonalSpace.resolve(this.#roomy);

    // authenticate sqlite
    tracer.startActiveSpan("Authenticate SQLite", {}, ctx, (span) => {
      this.sqlite
        .authenticate(UserDid.assert(roomy.agent.did))
        .catch((e) => console.error("Failed to authenticate sqlite worker", e))
        .finally(() => span.end());
    });

    this.startMaterializer();

    const lastBatchId = await tracer.startActiveSpan(
      "Wait For Personal Stream Backfill",
      {},
      ctx,
      async (span) => {
        const batch = await personalSpace.doneBackfilling;
        span.end();
        return batch;
      },
    );

    // ensure the backfilled stream is fully materialised
    const personalSpaceMaterialised = new Promise((resolve) => {
      this.#batchResolvers.set(lastBatchId, resolve);
    });

    this.#status.spaces = {
      ...this.#status.spaces,
      [personalSpace.streamDid]: "idle",
    };

    if (this.#status.authState?.state !== "authenticated")
      throw new Error("Not authenticated");

    await tracer.startActiveSpan(
      "Wait for Personal Stream Materialized",
      {},
      ctx,
      async (span) => {
        await personalSpaceMaterialised;
        span.end();
      },
    );

    // get streams from SQLite
    const streamsResult = await this.sqlite.runQuery<{
      id: StreamDid;
      backfilled_to: StreamIndex;
    }>(sql`-- backend space list
      select e.id as id, cs.backfilled_to from entities e join comp_space cs on e.id = cs.entity
      where hidden = 0
    `);

    // pass them to the client
    const spacesToConnect = new Map(
      (streamsResult.rows || []).map((row) => {
        return [row.id, row.backfilled_to] as const;
      }),
    );

    // set all spaces to 'loading' in reactive status
    this.#status.spaces = {
      ...Object.fromEntries(
        [...spacesToConnect.entries()].map(([spaceId]) => [spaceId, "loading"]),
      ),
    };

    // Connect to spaces the user has joined (but not left) after full personal stream backfill
    await tracer.startActiveSpan(
      "Connect Pending Spaces",
      {},
      ctx,
      async (span) => {
        await this.sqlite.sqliteWorker.connectPendingSpaces();
        span.end();
      },
    );

    this.#roomy = {
      ...this.#roomy,
      state: "connected",
      eventChannel,
      spaces: new Map([...this.#roomy.spaces.entries()]),
    };
    this.#status.roomyState = {
      personalSpace: personalSpace.streamDid,
      state: "connected",
    };
    this.#connected.resolve(this.#roomy);

    await tracer.startActiveSpan(
      "Wait for Joined Streams Backfilled",
      {},
      ctx,
      async (span) => {
        for (const space of this.spaces.values()) {
          (async () => {
            await space.doneBackfilling;
            this.#status.spaces = {
              ...this.#status.spaces,
              [space.streamDid]: "idle",
            };
          })();
        }
        span.end();
      },
    );

    console.info("Backend initialised!");

    span.end();
  }

  // get a URL for redirecting to the ATProto PDS for login
  async login(handle: string) {
    const oauth = await createOauthClient();
    const url = await oauth.authorize(handle, {
      scope: CONFIG.atprotoOauthScope,
    });
    return url.href;
  }

  async logout() {
    await db.kv.delete("did");
    await oauthDb.session.clear();
    await oauthDb.state.clear();
  }

  private async startMaterializer() {
    console.debug("Starting materialiser");
    const { eventChannel } = await this.#connectedPersonalSpace.promise; // TODO await roomy connected
    if (
      this.#roomy.state !== "connected" &&
      this.#roomy.state !== "materializingPersonalSpace" // should be this one
    ) {
      throw new Error("Tried to handle events while unauthenticated");
    }

    console.debug("listening on eventChannel...");

    for await (const batch of eventChannel) {
      // personal stream backfill is always high priority, other streams can be in background
      if (batch.streamId === this.#roomy.personalSpace.streamDid) {
        const result = await this.sqlite.materializeBatch(batch, "priority");

        // If there is a resolver waiting on this batch, resolve it with the result
        const resolver = this.#batchResolvers.get(batch.batchId);
        if (resolver) {
          resolver(result);
          this.#batchResolvers.delete(batch.batchId);
        }

        // Check for event ID resolvers (for sendEvent waiting on materialization)
        this.resolveEventPromises(result);

        logMaterializationResult(batch.streamId, result, "personal");
      } else {
        const result = await this.sqlite.materializeBatch(
          batch,
          batch.priority,
        );

        // If there is a resolver waiting on this batch, resolve it with the result
        const resolver = this.#batchResolvers.get(batch.batchId);
        if (resolver) {
          resolver(result);
          this.#batchResolvers.delete(batch.batchId);
        }

        // Check for event ID resolvers (for sendEvent waiting on materialization)
        this.resolveEventPromises(result);

        logMaterializationResult(batch.streamId, result, "space");
      }
    }
  }

  /** Resolve any pending event promises based on materialized results */
  private resolveEventPromises(result: Batch.Statement | Batch.ApplyResult) {
    if (result.status !== "applied") return;

    for (const bundleResult of result.results) {
      if ("eventId" in bundleResult && bundleResult.eventId) {
        const resolver = this.#batchResolvers.get(bundleResult.eventId);
        if (resolver) {
          resolver(result);
          this.#batchResolvers.delete(bundleResult.eventId);
        }
      }
    }
  }

  /** Timeout for connecting to a single space (30 seconds) */
  static SPACE_CONNECTION_TIMEOUT_MS = 30_000;

  async connectSpaceStream(streamId: StreamDid, _idx: StreamIndex) {
    await this.#connectedPersonalSpace.promise;
    if (
      this.#roomy.state !== "connected" &&
      this.#roomy.state !== "materializingPersonalSpace"
    )
      throw new Error("Roomy must be connected to add new space stream");

    const alreadyConnected = this.#roomy.spaces.get(streamId);
    if (alreadyConnected) return;

    await tracer.startActiveSpan(
      `Connect Space`,
      { attributes: { "stream.id": streamId } },
      async (span) => {
        try {
          const connectionPromise = this.#connectSpaceStreamInner(streamId);

          // Hard timeout that rejects - prevents one slow space from blocking everything
          let timedOut = false;
          const result = await withTimeoutCallback(
            connectionPromise,
            () => {
              timedOut = true;
              console.error(
                `Space connection timed out after ${WorkerSupervisor.SPACE_CONNECTION_TIMEOUT_MS}ms`,
                {
                  streamId,
                },
              );
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: "Connection timed out",
              });
            },
            WorkerSupervisor.SPACE_CONNECTION_TIMEOUT_MS,
          );

          if (timedOut) {
            // Mark as error since it timed out (even if it eventually completes)
            this.#status.spaces = {
              ...this.#status.spaces,
              [streamId]: "error",
            };
          }

          span.end();
          return result;
        } catch (e) {
          console.error("Failed to connect to space", { streamId, error: e });
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: e instanceof Error ? e.message : String(e),
          });
          span.end();
          this.#status.spaces = {
            ...this.#status.spaces,
            [streamId]: "error",
          };
        }
      },
    );
  }

  async #connectSpaceStreamInner(streamId: StreamDid) {
    if (
      this.#roomy.state !== "connected" &&
      this.#roomy.state !== "materializingPersonalSpace"
    )
      throw new Error("No event channel yet");

    const space = await ConnectedSpace.connect({
      client: this.client,
      streamDid: streamId,
      module: modules.space,
    });

    const callback = this.#createEventCallback(
      this.#roomy.eventChannel,
      streamId,
    );

    // First get metadata to find latest index, then subscribe from there
    const latest = await withTimeoutCallback(
      space.subscribeMetadata(callback, 0),
      () => console.warn(`Waiting for space metadata backfill`, { streamId }),
      5000,
    );
    await space.unsubscribe();

    await withTimeoutCallback(
      space.subscribe(callback, latest),
      () => console.warn(`Waiting for space events backfill`, { streamId }),
      5000,
    );

    this.#roomy.spaces.set(streamId, space);
    this.#status.spaces = {
      ...this.#status.spaces,
      [streamId]: "idle",
    };
  }

  async createSpaceStream() {
    if (this.#roomy.state !== "connected")
      throw new Error("Client must be connected to add new space stream");

    const newSpace = await ConnectedSpace.create(
      {
        client: this.client,
        module: modules.space,
      },
      UserDid.assert(this.client.agent.assertDid),
    );

    // Subscribe with callback that pushes to eventChannel
    const callback = this.#createEventCallback(
      this.#roomy.eventChannel,
      newSpace.streamDid,
    );
    await newSpace.subscribe(callback);

    console.debug("Successfully created space stream:", newSpace.streamDid);

    // add to stream connection map
    this.#roomy.spaces.set(newSpace.streamDid, newSpace);

    return newSpace.streamDid;
  }

  async sendEventBatch(spaceId: string, payloads: Event[]) {
    const encodedPayloads = payloads.map((x) => {
      try {
        return encode(x);
      } catch (e) {
        throw new Error(
          `Could not encode event: ${JSON.stringify(x, null, "  ")}`,
          { cause: e },
        );
      }
    });
    console.debug("sending event batch", {
      spaceId,
      payloads,
      encodedPayloads,
    });
    await this.client.leaf.sendEvents(spaceId, encodedPayloads);
  }

  async fetchEvents(
    spaceId: string,
    start: number,
    limit: number,
  ): Promise<EncodedStreamEvent[]> {
    const resp = await this.client.leaf?.query(spaceId, {
      name: "events",
      params: {},
      limit,
      start,
    });
    const events = parseEvents(resp);
    return events;
  }

  async lazyLoadRoom(spaceId: StreamDid, roomId: Ulid, end?: StreamIndex): Promise<{ hasMore: boolean }> {
    await this.#connected.promise;
    if (this.#roomy.state !== "connected")
      throw new Error("Client not connected");

    const space = this.#roomy.spaces.get(spaceId);
    if (!space) throw new Error("Could not find space in connected streams");

    const ROOM_FETCH_BATCH_SIZE = 100;
    const events = await space.lazyLoadRoom(roomId, ROOM_FETCH_BATCH_SIZE, end);

    if (events.length > 0) {
      const batchId = newUlid();
      const materialized = new Promise<void>((resolve) => {
        this.#batchResolvers.set(batchId, () => resolve());
      });

      this.#roomy.eventChannel.push({
        status: "events",
        batchId,
        streamId: spaceId,
        events,
        priority: "priority",
      });

      await materialized;
    }

    return { hasMore: events.length >= ROOM_FETCH_BATCH_SIZE };
  }

  async fetchLinks(
    spaceId: StreamDid,
    start: StreamIndex,
    limit: number,
    room?: Ulid,
  ): Promise<DecodedStreamEvent[]> {
    await this.#connected.promise;
    if (this.#roomy.state !== "connected")
      throw new Error("Client not connected");

    const space = this.#roomy.spaces.get(spaceId);
    if (!space) throw new Error("Could not find space in connected streams");

    return await space.fetchLinks(start, limit, room);
  }

  /** Create an event callback that pushes to the eventChannel.
   * Optionally registers a post-materialization callback that runs after the batch is processed. */
  #createEventCallback(
    eventChannel: AsyncChannel<Batch.Events>,
    streamId: StreamDid,
    onBatch?: (result: Batch.Statement | Batch.ApplyResult) => void,
  ): EventCallback {
    return (events: DecodedStreamEvent[], { isBackfill, batchId }) => {
      if (events.length === 0) return;
      if (onBatch) {
        // Register the post-materialization callback for this batch
        this.#batchResolvers.set(batchId, onBatch);
      }
      eventChannel.push({
        status: "events",
        batchId,
        streamId,
        events,
        priority: isBackfill ? "background" : "priority",
      });
    };
  }

  /**
   *
   * CONVENIENCES
   *
   */

  private get consoleForwarding() {
    return this.#config.consoleForwarding;
  }

  private get client() {
    if (
      this.#roomy.state !== "connected" &&
      this.#roomy.state !== "materializingPersonalSpace"
    )
      throw new Error("Not connected to RoomyClient");
    return this.#roomy.client;
  }

  private get sqlite() {
    return this.#sqlite;
  }

  private get spaces() {
    if (
      this.#roomy.state !== "connected" &&
      this.#roomy.state !== "materializingPersonalSpace"
    )
      throw new Error("Not connected to RoomyClient");
    return this.#roomy.spaces;
  }

  private loadStoredConfig() {
    db.kv
      .get("consoleForwarding")
      .then((pref) => (this.#config.consoleForwarding = !!pref?.value));
  }

  private async enableLogForwarding() {
    await db.kv.put({ key: "consoleForwarding", value: "true" });
    this.#config.consoleForwarding = true;
  }

  private async disableLogForwarding() {
    await db.kv.put({ key: "consoleForwarding", value: "" });
    this.#config.consoleForwarding = false;
  }

  /**
   *
   * DIAGNOSTICS
   *
   */

  async debugFetchPersonalStream(): Promise<Event[]> {
    if (this.#status.roomyState?.state != "connected") {
      throw "Not authenticated";
    }
    return this.debugFetchStream(this.#status.roomyState.personalSpace);
  }

  async debugFetchStream(streamId: string): Promise<Event[]> {
    if (this.#status.roomyState?.state != "connected") {
      throw "Not authenticated";
    }
    const resp = await this.fetchEvents(streamId, 0, 1e10);

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

  // /** Testing: Trigger personal stream creation */
  async ensurePersonalStream(): Promise<void> {
    if (this.#auth.state !== "authenticated") {
      throw new Error("Cannot ensure personal stream: not authenticated");
    }
    // await this.client.connectPersonalSpace(this.#auth.eventChannel);
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

  async authenticate(did: UserDid) {
    await this.untilReady;
    await this.sqliteWorker.authenticate(did);
    console.debug(`SQLite reinitialised with did: ${did}`);
  }

  async setReady(workerInterface: SqliteWorkerInterface) {
    if (this.#state.state === "pending") {
      const previousSchemaVersion = await prevStream.getSchemaVersion();
      console.debug("(init.2) SQLite Supervisor ready.", {
        previousSchemaVersion,
        current: CONFIG.streamSchemaVersion,
      });
      if (
        previousSchemaVersion &&
        previousSchemaVersion != CONFIG.streamSchemaVersion
      ) {
        // Reset the local database cache when the stream schema version changes.
        // Asynchronous, but has to wait until readyPromise is resolved, so we can't await it here.
        this.sqliteWorker.resetLocalDatabase().catch(console.error);
      }

      await prevStream.setSchemaVersion(CONFIG.streamSchemaVersion);

      // Reset the local database cache when the database schema version changes
      (async () => {
        const result = await this.runQuery<{ version: string }>(
          sql`select version from roomy_schema_version`,
        );
        if (result.rows?.[0]?.version !== CONFIG.databaseSchemaVersion) {
          await this.sqliteWorker.resetLocalDatabase();
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

  async materializeBatch(events: Batch.Events, priority: TaskPriority) {
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
}

const worker = new WorkerSupervisor();
(globalThis as any).worker = worker; // For debugging only !!
