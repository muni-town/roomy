import { type Batch, type StreamIndex, type TaskPriority } from "../types";
import {
  messagePortInterface,
  reactiveChannelState,
  type MessagePortApi,
} from "../internalMessaging";
import { sql } from "$lib/utils/sqlTemplate";
import { CONFIG } from "$lib/config";
import { db } from "../idb";
import type { QueryResult } from "../sqlite/setup";
import {
  type AuthState,
  type PeerStatus,
  type PeerInterface,
  type SqliteState,
  type RoomyState,
  type PeerClientInterface,
  type AuthStatus,
  type RoomyStatus,
  roomyStateTrackable as roomyStateTrackable,
  authStateTrackable,
} from "./types";
import type {
  Savepoint,
  SqliteWorkerInterface as SqliteInterface,
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
  type Profile,
  statusMachine,
  type StatusMachine,
  stateMachine,
  type StateMachine,
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
import { context, SpanStatusCode } from "@opentelemetry/api";
import { logMaterializationResult } from "../materializationLogging";
import { createOauthClient, oauthDb } from "./oauth";
import { Agent, CredentialSession } from "@atproto/api";
import { lexicons } from "$lib/lexicons";
import type { SessionManager } from "@atproto/api/dist/session-manager";

/** Helper type that is a session manager where the DID is asserted to be defined. */
type SessionManagerWithDid = Omit<SessionManager, "did"> & { did: string };

/** Helper to get the broadcast channel for the peerStatus for a specific session. */
export const peerStatusChannel = (sessionId: string) =>
  new BroadcastChannel(`peer-status-${sessionId}`);

/** Helper to cache the session DID to use when restoring sessions */
const sessionDidCache = {
  kvKey: "sessionDid",
  get(): Promise<string | undefined> {
    return db.kv.get(this.kvKey).then((x) => x?.value);
  },
  put(did: string): Promise<void> {
    return db.kv.put({ key: this.kvKey, value: did }).then(() => {});
  },
  clear(): Promise<void> {
    return db.kv.delete(this.kvKey);
  },
};

/**
 * The peer implementation, wrapping up authentication and materialization of the roomy state.
 * */
export class Peer {
  /** The current user session ID, used primarily for telemetry */
  #sessionId: string;

  /** The current authentication state of the peer. */
  #auth: StatusMachine<AuthState, AuthStatus>;
  /** The current state of the roomy client. */
  #roomy: StatusMachine<RoomyState, RoomyStatus>;

  /** Helper to set the profile in the reactive {@link PeerStatus} for this peer. */
  #updateReactiveProfile: (profile: Profile | undefined) => void;

  /** Helper to update the reactive space statuses for clients. */
  #spaceStatuses: {
    set(id: StreamDid, status: "loading" | "idle" | "error"): void;
    setBatch(ids: [StreamDid, "loading" | "idle" | "error"][]): void;
  };

  #sqlite: SqliteSupervisor;

  /* To get the result of a materialised batch, create and await a Promise setting the resolver
    against the Batch ID in this Map */
  #batchResolvers: Map<
    Ulid,
    (value: Batch.Statement | Batch.ApplyResult) => void
  > = new Map();

  /** Construct a new peer with the provided sesion ID. */
  constructor(opts: { sessionId: string }) {
    // Store the session
    this.#sessionId = opts.sessionId;

    // Create the sqlite supervisor
    this.#sqlite = new SqliteSupervisor();

    // Create a reactive peer status that the UI can subscribe to.
    const reactiveStatus = reactiveChannelState<PeerStatus>(
      peerStatusChannel(this.#sessionId), // Use the session-specific broadcast channel
      true, // We are the provider of these values
    );

    // Create helpers that the class can use to update the reactive space statuses.
    this.#spaceStatuses = {
      set(id, status) {
        reactiveStatus.spaces = { ...reactiveStatus.spaces, [id]: status };
      },
      setBatch(ids) {
        reactiveStatus.spaces = {
          ...Object.fromEntries(ids.map(([spaceId]) => [spaceId, "loading"])),
        };
      },
    };

    // Create helper for updating the profile in the reactive status
    this.#updateReactiveProfile = (profile) => {
      reactiveStatus.profile = profile;
    };

    // Initialize the auth state
    this.#auth = statusMachine<AuthState, AuthStatus>(authStateTrackable);

    // Subscribe to auth state changes and update reactive status
    this.#auth.subscribeStatus((status) => {
      reactiveStatus.authState = status;
    });

    // Initialize the roomy client state
    this.#roomy = statusMachine<RoomyState, RoomyStatus>(roomyStateTrackable);

    // Subscribe to roomy client state changes and update reactive status
    this.#roomy.subscribeStatus((status) => {
      reactiveStatus.roomyState = status;
    });
  }

  /**
   * Create the peer RPC interaface that is the primary way to interact with the peer after
   * creation.
   * */
  getPeerInterface(this: Peer): PeerInterface {
    return {
      initializePeer: (oauthCallbackSearchParams) =>
        this.initializePeer(oauthCallbackSearchParams),
      login: async (handle) => this.login(handle),
      logout: async () => await this.logout(),
      setSpaceHandle: (spaceDid, handle) => {
        if (this.#roomy.current.state !== "connected")
          throw new Error("Not connected");
        return this.#roomy.current.client.setHandle(spaceDid, handle);
      },
      getSpaceInfo: (streamDid) => {
        if (this.#roomy.current.state !== "connected")
          throw new Error("Not connected");
        return this.#roomy.current.client.getSpaceInfo(streamDid);
      },
      getProfile: async (did) => {
        return this.client.getProfile(did);
      },
      runQuery: async (statement) => {
        return this.#sqlite.runQuery(statement);
      },
      createLiveQuery: async (lockId, port, statement) => {
        // Try to obtain a lock on the query. This will stall until the frontend is done with the
        // query.
        navigator.locks.request(lockId, async () => {
          // Once we have a lock on the query, we know the frontend has stopped using it, so we can
          // delete it.
          await this.#sqlite.deleteLiveQuery(lockId);
        });
        return this.#sqlite.createLiveQuery(lockId, port, statement);
      },
      deleteLiveQuery: async (id) => {
        await this.#sqlite.deleteLiveQuery(id);
      },
      dangerousCompletelyDestroyDatabase: async ({ yesIAmSure }) => {
        if (!yesIAmSure) throw "You need to be sure";
        return await this.#sqlite.sqliteWorker.resetLocalDatabase();
      },
      setActiveSqliteWorker: async (messagePort) => {
        // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        await this.#sqlite.setSqliteInterface(
          messagePortInterface<{}, SqliteInterface>({
            localName: "peer",
            remoteName: "sqlite",
            messagePort,
            handlers: {},
          }),
        );
      },
      async ping() {
        console.info("Peer: Ping received");
        return {
          timestamp: Date.now(),
        };
      },
      connectSpaceStream: async (streamId, idx) => {
        await this.connectSpaceStream(streamId, idx);
      },
      createSpaceStream: async () => {
        const streamId = await this.createSpaceStream();
        this.#spaceStatuses.set(streamId, "idle");
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
        const result = await this.lazyLoadRoom(streamId, roomId, end);
        return result;
      },
      fetchLinks: async (streamId, start, limit, room) =>
        this.fetchLinks(streamId, start, limit, room),
      uploadToPds: async (bytes, opts) => {
        return this.client.uploadBlob(bytes, opts);
      },
      connectRpcClient: async (port) => this.connectRpcClient(port),
      pauseSubscription: async (_streamId) => {
        // await this.openSpacesMaterializer?.pauseSubscription(streamId);
      },
      unpauseSubscription: async (_streamId) => {
        // await this.openSpacesMaterializer?.unpauseSubscription(streamId);
      },
      resolveHandleForSpace: async (spaceId) =>
        this.client.resolveHandleFromSpaceId(spaceId),
      resolveSpaceId: async (handleOrDid) => {
        const { client } = await this.#roomy.transitionedTo("connected");
        const resp = await client.resolveSpaceIdFromDidOrHandle(handleOrDid);
        return {
          spaceId: resp.spaceDid,
          handle: resp.handle,
        };
      },
      checkSpaceExists: async (_spaceId) =>
        // TODO: right now we actually don't have a way check for stream existence in the API. This
        // should make sure things mostly work for now, but should be fixed later. The only impact
        // should be that we can't show proper 404 errors for missing spaces.
        true,
      setProfileSpace: async (spaceId) => {
        await this.client.setProfileSpace(spaceId);
      },
      getProfileSpace: async () => {
        const { client } = await this.#roomy.transitionedTo("connected");
        return client.resolveProfileSpaceFromUserDid(
          this.client.agent.assertDid as UserDid,
        );
      },
      getStreamRecord: async () => this.getStreamRecord(),
      deleteStreamRecord: async () => this.deleteStreamRecord(),
      ensurePersonalStream: async () => this.ensurePersonalStream(),
      connectPendingSpaces: async () => {
        await this.#sqlite.sqliteWorker.connectPendingSpaces();
      },
      getMembers: async (spaceDid) => {
        const { client } = await this.#roomy.transitionedTo("connected");
        // TODO: we should move this logic to the SDK
        const resp = await client.leaf.query(spaceDid, {
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

  /**
   * Connect an RPC client to the peer over the provided message port.
   *
   * The client will be able to call the {@link PeerInterface} on the port using the
   * {@link messagePortInterface} and the {@link Peer} will be able to call the the
   * {@link PeerClientInterface} on the client.
   */
  connectRpcClient(messagePort: MessagePortApi) {
    // Create the client interface wrapper around the message port
    const peerClientInterface = messagePortInterface<
      PeerInterface,
      PeerClientInterface
    >({
      localName: "peer",
      remoteName: "main",
      messagePort,
      handlers: this.getPeerInterface(),
    });

    // Let the client know the peer's session ID right away
    peerClientInterface.setSessionId(this.#sessionId);

    // Let the client know as soon as we get connected to the roomy server
    this.#roomy.transitionedTo("connected").then(({ client }) => {
      peerClientInterface.initFinished({
        userDid: client.agent.assertDid,
      });
    });
  }

  /**
   * Initialize the peer.
   *
   * If `oauthCallbackSearchParams` is provided, then it will create a new OAuth session using the
   * callback params.
   *
   * If `oauthCallbackSearchParams` is not provided, then it will try to restore the previous
   * session and initialize as unauthenticated if that is not possible.
   * */
  private async initializePeer(
    oauthCallbackParams?: string,
  ): Promise<{ did?: string }> {
    let [initSpan, ctx] = tracer.startActiveSpan(
      "Initialize Peer",
      (span) => [span, context.active()] as const,
    );

    console.debug("Initialising Peer", {
      oauthCallbackParams,
    });

    return context.with(ctx, async () => {
      // attempt to authenticate using a previous session or the oauth callback
      const session = await this.authenticate(oauthCallbackParams);

      // If we did not recieve a session, then set our state to unauthenticated
      if (!session) {
        console.info("Not authenticated");
        this.#auth.current = { state: "unauthenticated" };
        return {};
      }

      // If we have a session, update our state to authenticated
      this.#auth.current = { state: "authenticated", session };
      faro.api.setSession({
        id: faro.api.getSession()?.id,
        attributes: { isSampled: "true", did: session.did },
      });

      console.debug("Session restored successfully");
      initSpan.end();

      // Initialize the peer with the new obtained session
      this.initPeerWithSession(session);

      return { did: session.did };
    });
  }

  /**
   * Authenticate the user, either creating a new session using oauth callback parameters, or by
   * trying to restore a previous session.
   *
   * Returns `null` if there was no previous session and we are not creating a new session from
   * OAuth params.
   * */
  private async authenticate(
    params?: string,
  ): Promise<SessionManagerWithDid | null> {
    const oauth = await createOauthClient();

    // If we have an oauth callback to respond to
    if (params) {
      const [span, _ctx] = tracer.startActiveSpan(
        "Create Session at OAuth Callback",
        {},
        (span) => [span, context.active()] as const,
      );

      try {
        // Try to create a new session using the oauth callback params
        const { session } = await oauth.callback(new URLSearchParams(params));
        span.end();

        // If we got a session, this shouldn't happen, but the type marks the did, so handle the
        // undefined case with an error.
        if (!session.did) throw new Error("No DID on session");

        // Cache the authenticated user's DID so we can use it to restore the session later.
        await sessionDidCache.put(session.did);

        // Return the session
        return session;
      } catch (e) {
        console.warn("OAuth callback failed", e);
        span.end();
        return null;
      }
    }

    // If we don't have an oauth callback to respond to, then try to restore the previous session.
    const [span, ctx] = tracer.startActiveSpan(
      "Refresh Session",
      {},
      (span) => [span, context.active()] as const,
    );

    // If we are configured for test authentication, use those credentials to login instead
    if (CONFIG.testingAppPassword && CONFIG.testingHandle) {
      console.debug("Using app password authentication for testing");
      const session = new CredentialSession(new URL("https://bsky.social"));
      try {
        await session.login({
          identifier: CONFIG.testingHandle,
          password: CONFIG.testingAppPassword,
        });
        span.end();

        if (!session.did) throw new Error("No DID on session");

        // Unfortunately typescript fails to recognize the did check above
        // so we annotate the type as having a did.
        const sess = session as CredentialSession & { did: string };

        return sess;
      } catch (error) {
        console.error("loginWithAppPassword: Login failed", error);
        span.end();
        throw error;
      }
    }

    // Try to get the last session's DID if one existed
    const did = await sessionDidCache.get();
    if (!did) return null;

    // If there's a cached DID from a previous session, try to restore it
    const session = await tracer.startActiveSpan(
      "Restore Oauth Session",
      {},
      ctx,
      (span) =>
        oauth.restore(did).catch((e) => {
          console.warn("Restore session failed", e);
          span.end();
          return null;
        }),
    );

    span.end();
    return session;
  }

  /**
   * This is where most of the peer initialization happens, right after authentication.
   *
   * Here we backfill the personal stream then set up the other streams for spaces the user has
   * joined.
   */
  async initPeerWithSession(session: SessionManager) {
    const [span, ctx] = tracer.startActiveSpan(
      "Init Peer With Client",
      (span) => [span, context.active()] as const,
    );

    // Create a new ATProto agent around the authenticated session
    const agent = new Agent(session);
    lexicons.forEach((l) => agent.lex.add(l as any));

    this.#roomy.current = { state: "connectingToServer" };

    // Create a Roomy client that will connect to the leaf server.
    const roomy = await context.bind(ctx, RoomyClient.create)(
      {
        agent,
        leafUrl: CONFIG.leafUrl,
        leafDid: CONFIG.leafServerDid,
        profileSpaceNsid: CONFIG.profileSpaceNsid,
        spaceNsid: CONFIG.streamNsid,
        plcDirectory: CONFIG.plcDirectory,
      },
      {
        onConnect: () => console.debug("Peer: connected"),
        onDisconnect: () => console.debug("Peer: disconnected"),
      },
    );

    // fetch profile in advance (don't await)
    tracer.startActiveSpan("Fetch Profile", {}, ctx, (span) => {
      roomy
        .getProfile()
        .then((profile) => {
          this.#updateReactiveProfile(profile);
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

    // Create a new event channel that we will use to capture new events coming from the server and
    // going to the materializer.
    const eventChannel = new AsyncChannel<Batch.Events>();

    // Create a callback that will subscribe to events and send them over the event channel to the
    // materializer.
    const callback = this.#createEventCallback(
      eventChannel,
      personalSpace.streamDid,
      // After each personal stream batch is materialized, connect to any new spaces
      async () => this.#sqlite.sqliteWorker.connectPendingSpaces(),
    );

    // backfill entire personal space by subscribing to all of its events.
    await personalSpace.subscribe(callback);

    // Ensure personal stream space entity exists
    await this.#sqlite.runQuery(
      ensureEntity(personalSpace.streamDid, personalSpace.streamDid),
    );

    // Mark personal stream space as hidden
    await this.#sqlite.runQuery(sql`
      insert into comp_space (entity, hidden)
      values (${personalSpace.streamDid}, 1) 
      on conflict (entity) do nothing
    `);

    this.#roomy.current = {
      state: "materializingPersonalSpace",
      client: roomy,
      personalSpace,
      eventChannel,
      spaces: new Map(),
    };

    // Start the SQLite materialization of events we send over the event stream.
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

    this.#spaceStatuses.set(personalSpace.streamDid, "idle");

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
    const streamsResult = await this.#sqlite.runQuery<{
      id: StreamDid;
      backfilled_to: StreamIndex;
    }>(sql`-- peer space list
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
    this.#spaceStatuses.setBatch(
      [...spacesToConnect.keys()].map((id) => [id, "loading"]),
    );

    // Connect to spaces the user has joined (but not left) after full personal stream backfill
    await tracer.startActiveSpan(
      "Connect Pending Spaces",
      {},
      ctx,
      async (span) => {
        await this.#sqlite.sqliteWorker.connectPendingSpaces();
        span.end();
      },
    );

    this.#roomy.current = {
      state: "connected",
      eventChannel,
      spaces: new Map([...this.#roomy.current.spaces.entries()]),
      client: this.#roomy.current.client,
      personalSpace: this.#roomy.current.personalSpace,
    };

    await tracer.startActiveSpan(
      "Wait for Joined Streams Backfilled",
      {},
      ctx,
      async (span) => {
        for (const space of this.spaces.values()) {
          (async () => {
            await space.doneBackfilling;
            this.#spaceStatuses.set(space.streamDid, "idle");
          })();
        }
        span.end();
      },
    );

    console.info("Peer initialised!");

    span.end();
  }

  /** Get a URL for redirecting to the ATProto PDS for login */
  async login(handle: string) {
    try {
      const oauth = await createOauthClient();
      const url = await oauth.authorize(handle, {
        scope: CONFIG.atprotoOauthScope,
      });
      return url.href;
    } catch (e) {
      console.error("Error getting oauth redirect", e);
      throw e;
    }
  }

  /** Logout of the current session. */
  async logout() {
    await sessionDidCache.clear();
    await oauthDb.session.clear();
    await oauthDb.state.clear();
  }

  /** Start materializng events that come over the event channel. */
  private async startMaterializer() {
    console.debug("Starting materialiser");
    const { eventChannel, personalSpace } = await Promise.race([
      this.#roomy.transitionedTo("materializingPersonalSpace"),
      this.#roomy.transitionedTo("connected"),
    ]);

    console.debug("listening on eventChannel...");

    for await (const batch of eventChannel) {
      // personal stream backfill is always high priority, other streams can be in background
      if (batch.streamId === personalSpace.streamDid) {
        const result = await this.#sqlite.materializeBatch(batch, "priority");

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
        const result = await this.#sqlite.materializeBatch(
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
    const { spaces } = await Promise.race([
      this.#roomy.transitionedTo("materializingPersonalSpace"),
      this.#roomy.transitionedTo("connected"),
    ]);

    const alreadyConnected = spaces.get(streamId);
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
                `Space connection timed out after ${Peer.SPACE_CONNECTION_TIMEOUT_MS}ms`,
                {
                  streamId,
                },
              );
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: "Connection timed out",
              });
            },
            Peer.SPACE_CONNECTION_TIMEOUT_MS,
          );

          if (timedOut) {
            // Mark as error since it timed out (even if it eventually completes)
            this.#spaceStatuses.set(streamId, "error");
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
          this.#spaceStatuses.set(streamId, "error");
        }
      },
    );
  }

  async #connectSpaceStreamInner(streamId: StreamDid) {
    if (
      this.#roomy.current.state !== "connected" &&
      this.#roomy.current.state !== "materializingPersonalSpace"
    )
      throw new Error("No event channel yet");

    const space = await ConnectedSpace.connect({
      client: this.client,
      streamDid: streamId,
      module: modules.space,
    });

    const callback = this.#createEventCallback(
      this.#roomy.current.eventChannel,
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

    this.#roomy.current.spaces.set(streamId, space);
    this.#spaceStatuses.set(streamId, "idle");
  }

  async createSpaceStream() {
    if (this.#roomy.current.state !== "connected")
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
      this.#roomy.current.eventChannel,
      newSpace.streamDid,
    );
    await newSpace.subscribe(callback);

    console.debug("Successfully created space stream:", newSpace.streamDid);

    // add to stream connection map
    this.#roomy.current.spaces.set(newSpace.streamDid, newSpace);

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

  async lazyLoadRoom(
    spaceId: StreamDid,
    roomId: Ulid,
    end?: StreamIndex,
  ): Promise<{ hasMore: boolean }> {
    return await tracer.startActiveSpan(
      "Lazy Load Room",
      {
        attributes: {
          "space.id": spaceId,
          "room.id": roomId,
        },
      },
      async (span) => {
        // Track how long we're blocked waiting for connected state
        const { spaces, eventChannel } = await tracer.startActiveSpan(
          "Wait for Connected State",
          { attributes: { "space.id": spaceId } },
          async (innerSpan) => {
            const result = await this.#roomy.transitionedTo("connected");
            innerSpan.end();
            return result;
          },
        );

        const space = spaces.get(spaceId);
        if (!space)
          throw new Error("Could not find space in connected streams");

        const ROOM_FETCH_BATCH_SIZE = 100;
        const events = await tracer.startActiveSpan(
          "Fetch Room Events",
          { attributes: { "space.id": spaceId, "room.id": roomId } },
          async (innerSpan) => {
            const fetchedEvents = await space.lazyLoadRoom(
              roomId,
              ROOM_FETCH_BATCH_SIZE,
              end,
            );
            innerSpan.setAttribute("event.count", fetchedEvents.length);
            innerSpan.end();
            return fetchedEvents;
          },
        );

        if (events.length > 0) {
          const batchId = newUlid();
          const materialized = new Promise<void>((resolve) => {
            this.#batchResolvers.set(batchId, () => resolve());
          });

          eventChannel.push({
            status: "events",
            batchId,
            streamId: spaceId,
            events,
            priority: "priority",
          });

          await materialized;
        }

        span.setAttribute("has.more", events.length >= ROOM_FETCH_BATCH_SIZE);
        span.end();
        return { hasMore: events.length >= ROOM_FETCH_BATCH_SIZE };
      },
    );
  }

  async fetchLinks(
    spaceId: StreamDid,
    start: StreamIndex,
    limit: number,
    room?: Ulid,
  ): Promise<DecodedStreamEvent[]> {
    const { spaces } = await this.#roomy.transitionedTo("connected");

    const space = spaces.get(spaceId);
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

  private get client() {
    if (
      this.#roomy.current.state !== "connected" &&
      this.#roomy.current.state !== "materializingPersonalSpace"
    )
      throw new Error("Not connected to RoomyClient");
    return this.#roomy.current.client;
  }

  private get spaces() {
    if (
      this.#roomy.current.state !== "connected" &&
      this.#roomy.current.state !== "materializingPersonalSpace"
    )
      throw new Error("Not connected to RoomyClient");
    return this.#roomy.current.spaces;
  }

  /**
   *
   * DIAGNOSTICS
   *
   */

  async debugFetchPersonalStream(): Promise<Event[]> {
    if (this.#roomy.current.state != "connected") {
      throw "Not authenticated";
    }
    return this.debugFetchStream(this.#roomy.current.personalSpace.streamDid);
  }

  async debugFetchStream(streamId: string): Promise<Event[]> {
    if (this.#roomy.current.state != "connected") {
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
    if (this.#auth.current.state !== "authenticated") {
      throw new Error("Cannot ensure personal stream: not authenticated");
    }
    // await this.client.connectPersonalSpace(this.#auth.eventChannel);
  }
}

class SqliteSupervisor {
  #state: StateMachine<SqliteState>;
  liveQueries: Map<string, { port: MessagePort; statement: SqlStatement }>;

  constructor() {
    this.#state = stateMachine({ state: "pending" });
    this.liveQueries = new Map();
  }

  get ready() {
    return this.#state.current.state === "ready";
  }

  get sqliteWorker() {
    if (this.#state.current.state !== "ready")
      throw new Error("Sqlite worker not initialised");
    return this.#state.current.sqliteWorker;
  }

  async setSqliteInterface(sqliteInterface: SqliteInterface) {
    // When a new SQLite interface is connected we need to make sure that we re-create all of the
    // live queries that were active on the old worker.
    for (const [id, { port, statement }] of this.liveQueries.entries()) {
      this.createLiveQuery(id, port, statement);
    }

    this.#state.current = {
      state: "ready",
      sqliteWorker: sqliteInterface,
    };
  }

  async materializeBatch(events: Batch.Events, priority: TaskPriority) {
    const { sqliteWorker } = await this.#state.transitionedTo("ready");
    return sqliteWorker.materializeBatch(events, priority);
  }

  // Type assertion for convenience. Todo: use Zod/Arktype for sql output validation?
  async runQuery<T = unknown>(statement: SqlStatement) {
    const { sqliteWorker } = await this.#state.transitionedTo("ready");
    return sqliteWorker.runQuery(statement) as Promise<QueryResult<T>>;
  }

  async runSavepoint(savepoint: Savepoint) {
    const { sqliteWorker } = await this.#state.transitionedTo("ready");
    return sqliteWorker.runSavepoint(savepoint);
  }

  async createLiveQuery(
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ) {
    const { sqliteWorker } = await this.#state.transitionedTo("ready");
    this.liveQueries.set(id, { port, statement });
    await sqliteWorker.createLiveQuery(id, port, statement);
  }

  async deleteLiveQuery(id: string) {
    const { sqliteWorker } = await this.#state.transitionedTo("ready");
    this.liveQueries.delete(id);
    await sqliteWorker.deleteLiveQuery(id);
  }
}
