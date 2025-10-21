/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference lib="webworker" />

import { LeafClient, type IncomingEvent } from "@muni-town/leaf-client";
import {
  type BackendInterface,
  type ConsoleInterface,
  type BackendStatus,
  type SqliteWorkerInterface,
  consoleLogLevels,
} from "./types";
import {
  messagePortInterface,
  reactiveWorkerState,
  type MessagePortApi,
} from "./workerMessaging";

import {
  atprotoLoopbackClientMetadata,
  buildLoopbackClientId,
  type OAuthClientMetadataInput,
  type OAuthSession,
} from "@atproto/oauth-client-browser";
import { OAuthClient } from "@atproto/oauth-client";
import { Agent } from "@atproto/api";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import Dexie, { type EntityTable } from "dexie";

import { lexicons } from "../lexicons";
import type { BindingSpec } from "@sqlite.org/sqlite-wasm";
import { config as materializerConfig, type EventType } from "./materializer";
import { workerOauthClient } from "./oauth";
import type { LiveQueryMessage } from "$lib/workers/setupSqlite";
import { eventCodec, id, streamParamsCodec } from "./encoding";
import { sql } from "$lib/utils/sqlTemplate";
import { ulid } from "ulidx";
import { LEAF_MODULE_PERSONAL } from "../moduleUrls";
import { CONFIG } from "$lib/config";
import { AsyncChannel } from "./asyncChannel";

// TODO: figure out why refreshing one tab appears to cause a re-render of the spaces list live
// query in the other tab.

/**
 * Check whether or not we are executing in a shared worker.
 *
 * On platforms like Android chrome where SharedWorkers are not available this script will run as a
 * dedicated worker instead of a shared worker.
 * */
const isSharedWorker = "SharedWorkerGlobalScope" in globalThis;

// Generate unique ID for this worker instance
const backendWorkerId = crypto.randomUUID();

const status = reactiveWorkerState<BackendStatus>(
  new BroadcastChannel("backend-status"),
  true,
);

const statusStartBackfillingStream = () => {
  if (!status.loadingSpaces) status.loadingSpaces = 0;
  status.loadingSpaces += 1;
};
const statusDoneBackfillingStream = () => {
  if (!status.loadingSpaces) return;
  status.loadingSpaces -= 1;
};

const atprotoOauthScope = "atproto transition:generic transition:chat.bsky";

interface KeyValue {
  key: string;
  value: string;
}
const db = new Dexie("mini-shared-worker-db") as Dexie & {
  kv: EntityTable<KeyValue, "key">;
  streamCursors: EntityTable<
    { streamId: string; latestEvent: number },
    "streamId"
  >;
};
db.version(1).stores({
  kv: `key`,
  streamCursors: `streamId`,
});

// Helpers for caching the personal stream ID in the key-value store.
const getPersonalStreamIdCache = async (
  did: string,
): Promise<string | undefined> => {
  return (
    await db.kv.get(`personalStreamId-${CONFIG.streamSchemaVersion}-${did}`)
  )?.value;
};
const setPersonalStreamIdCache = async (
  did: string,
  value: string,
): Promise<void> => {
  await db.kv.put({
    key: `personalStreamId-${CONFIG.streamSchemaVersion}-${did}`,
    value,
  });
};
const clearPersonalStreamIdCache = async () => {
  await db.kv.filter((x) => x.key.startsWith("personalStreamId-")).delete();
};
// Helpers for getting/setting the previous stream schema version in the key-value store.
const getPreviousStreamSchemaVersion = async (): Promise<
  string | undefined
> => {
  return (await db.kv.get("previousStreamSchemaVersion"))?.value;
};
const setPreviousStreamSchemaVersion = async (version: string) => {
  await db.kv.put({ key: "previousStreamSchemaVersion", value: version });
};

export let sqliteWorker: SqliteWorkerInterface | undefined;
let setSqliteWorkerReady = () => {};
const sqliteWorkerReady = new Promise(
  (resolve) => (setSqliteWorkerReady = resolve as () => void),
);

/**
 * Helper class wrapping up our worker state behind getters and setters so we run code whenever
 * they are changed.
 * */
class Backend {
  #oauth: OAuthClient | undefined;
  #agent: Agent | undefined;
  #session: OAuthSession | undefined;
  #profile: ProfileViewDetailed | undefined;
  #leafClient: LeafClient | undefined;
  personalSpaceMaterializer: StreamMaterializer | undefined;
  openSpacesMaterializer: OpenSpacesMaterializer | undefined;

  #oauthReady: Promise<void>;
  #resolveOauthReady: () => void = () => {};
  get ready() {
    return state.#oauthReady;
  }

  constructor() {
    console.log("Starting roomy backend");
    this.#oauthReady = new Promise((r) => (this.#resolveOauthReady = r));
    createOauthClient().then((client) => {
      this.setOauthClient(client);
    });
  }

  get oauth() {
    return this.#oauth;
  }

  setOauthClient(oauth: OAuthClient) {
    this.#oauth = oauth;

    if (oauth) {
      (async () => {
        // if there's a stored DID and no session yet, try to restore the session
        const entry = await db.kv.get("did");
        if (entry && this.oauth && !this.session) {
          try {
            const restoredSession = await this.oauth.restore(entry.value);
            this.setSession(restoredSession);
          } catch (e) {
            console.error(e);
            this.logout();
          }
        }
        this.#resolveOauthReady();
        status.authLoaded = true;
      })();
    } else {
      this.setSession(undefined);
    }
  }

  get session() {
    return this.#session;
  }

  setSession(session: OAuthSession | undefined) {
    this.#session = session;
    status.did = session?.did;
    if (session) {
      console.log("Setting up agent");
      db.kv.add({ key: "did", value: session.did });
      this.setAgent(new Agent(session));
    } else {
      this.setAgent(undefined);
    }
  }

  get agent() {
    return this.#agent;
  }

  setAgent(agent: Agent | undefined) {
    this.#agent = agent;
    if (agent) {
      lexicons.forEach((l) => agent.lex.add(l as any));
      agent.getProfile({ actor: agent.assertDid }).then((resp) => {
        this.profile = resp.data;
      });

      if (!this.#leafClient) {
        this.setLeafClient(
          new LeafClient(CONFIG.leafUrl, async () => {
            const resp = await this.agent?.com.atproto.server.getServiceAuth({
              aud: `did:web:${new URL(CONFIG.leafUrl).host}`,
            });
            if (!resp) throw "Error authenticating for leaf server";
            return resp.data.token;
          }),
        );
      }
    } else {
      this.profile = undefined;
      this.#leafClient?.disconnect();
      this.setLeafClient(undefined);
    }
  }

  get profile() {
    return this.#profile;
  }
  set profile(profile) {
    this.#profile = profile;
    status.profile = profile;
  }

  get leafClient() {
    return this.#leafClient;
  }
  setLeafClient(client: LeafClient | undefined) {
    if (client) {
      initializeLeafClient(client);
    } else {
      this.#leafClient?.disconnect();
    }
    this.#leafClient = client;
  }

  async oauthCallback(params: URLSearchParams) {
    await this.#oauthReady;
    const response = await state.oauth?.callback(params);
    this.setSession(response?.session);
  }

  logout() {
    db.kv.delete("did");
    this.setSession(undefined);
  }
}

const state = new Backend();
(globalThis as any).state = state;

// Track connected ports to prevent duplicate connections and for broadcasting
const connectedPorts = new WeakMap<MessagePortApi, string>();
const activePorts = new Set<MessagePortApi>();
let connectionCounter = 0;
let consoleForwardingSetup = false;

if (isSharedWorker) {
  (globalThis as any).onconnect = async ({
    ports: [port],
  }: {
    ports: [MessagePort];
  }) => {
    connectMessagePort(port);
  };
} else {
  connectMessagePort(globalThis);
}

const liveQueries: Map<string, { port: MessagePort; statement: SqlStatement }> =
  new Map();
(globalThis as any).liveQueries = liveQueries;

export async function getProfile(
  did: string,
): Promise<ProfileViewDetailed | undefined> {
  await state.ready;
  if (!did || did == state.agent?.did) {
    return state.profile;
  }
  const resp = await state.agent?.getProfile({
    actor: did || state.agent.assertDid,
  });
  if (!resp?.data && !resp?.success) {
    console.error("error fetching profile", resp, state.agent);
    throw new Error("Error fetching profile:" + resp?.toString());
  }
  return resp.data;
}

function connectMessagePort(port: MessagePortApi) {
  // Prevent duplicate connections - only connect once per port
  if (connectedPorts.has(port)) {
    const existingId = connectedPorts.get(port);
    console.log(
      `SharedWorker: Port already connected (ID: ${existingId}), skipping duplicate connection`,
    );
    return;
  }

  const connectionId = `conn-${++connectionCounter}`;
  connectedPorts.set(port, connectionId);

  // Log connection BEFORE setting up console forwarding to avoid broadcast duplication
  console.log(
    `SharedWorker backend connected (ID: ${connectionId}, total: ${connectionCounter})`,
  );

  // Clean up on port close/error
  if ("addEventListener" in port) {
    const cleanup = () => {
      activePorts.delete(port);
      console.log(`SharedWorker: Port disconnected (ID: ${connectionId})`);
    };

    // MessagePort has close event in some browsers
    (port as MessagePort).addEventListener("messageerror", cleanup);
  }

  // Add port to active ports for broadcasting
  activePorts.add(port);

  const resetLocalDatabase = async () => {
    if (!sqliteWorker)
      throw new Error("Sqlite worker not initialized when resetting database.");
    await sqliteWorker.runQuery(sql`pragma writable_schema = 1`);
    await sqliteWorker.runQuery(sql`delete from sqlite_master`);
    await sqliteWorker.runQuery(sql`vacuum`);
    await sqliteWorker.runQuery(sql`pragma integrity_check`);
    await db.streamCursors.clear();
    await clearPersonalStreamIdCache();
  };

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  const consoleInterface = messagePortInterface<
    BackendInterface,
    ConsoleInterface
  >(port, {
    async login(handle) {
      if (!state.oauth) throw "OAuth not initialized";
      const url = await state.oauth.authorize(handle, {
        scope: atprotoOauthScope,
      });
      return url.href;
    },
    async oauthCallback(paramsStr) {
      const params = new URLSearchParams(paramsStr);
      await state.oauthCallback(params);
    },
    async logout() {
      state.logout();
    },
    async loadProfile(did) {
      if (!state.agent) return;
      const resp = await state.agent.getProfile({ actor: did });
      if (resp.success) {
        return {
          id: resp.data.did,
          avatar: resp.data.avatar,
          banner: resp.data.banner,
          description: resp.data.description,
          displayName: resp.data.displayName,
          handle: resp.data.handle,
        };
      }
    },
    async runQuery(statement: SqlStatement) {
      await sqliteWorkerReady;
      if (!sqliteWorker) throw new Error("Sqlite worker not initialized");
      return await sqliteWorker.runQuery(statement);
    },
    async createLiveQuery(id, port, statement) {
      await sqliteWorkerReady;

      liveQueries.set(id, { port, statement });
      const channel = new MessageChannel();
      channel.port1.onmessage = (ev) => {
        port.postMessage(ev.data);
      };
      navigator.locks.request(id, async () => {
        // When we obtain a lock to the query ID, that means that the query is no longer in
        // use and we can delete it.
        liveQueries.delete(id);
        await sqliteWorker?.deleteLiveQuery(id);
      });
      if (!sqliteWorker) throw new Error("Sqlite worker not initialized");
      return await sqliteWorker.createLiveQuery(id, channel.port2, statement);
    },
    async dangerousCompletelyDestroyDatabase({ yesIAmSure }) {
      if (!yesIAmSure) throw "You need to be sure";
      if (!sqliteWorker) throw "Sqlite worker not initialized";
      resetLocalDatabase();
    },
    async setActiveSqliteWorker(messagePort) {
      console.log("Setting active SQLite worker");
      const firstUpdate = !sqliteWorker;

      // eslint-disable-next-line @typescript-eslint/no-empty-object-type
      sqliteWorker = messagePortInterface<{}, SqliteWorkerInterface>(
        messagePort,
        {},
      );

      if (firstUpdate) {
        const previousSchemaVersion = await getPreviousStreamSchemaVersion();
        if (previousSchemaVersion != CONFIG.streamSchemaVersion) {
          // Reset the local database cache when the schema version changes.
          await resetLocalDatabase();
        }
        await setPreviousStreamSchemaVersion(CONFIG.streamSchemaVersion);
      }

      setSqliteWorkerReady();

      // When a new SQLite worker is created we need to make sure that we re-create all of the
      // live queries that were active on the old worker.
      for (const [id, { port, statement }] of liveQueries.entries()) {
        const channel = new MessageChannel();
        channel.port1.onmessage = (ev) => {
          port.postMessage(ev.data);
        };
        sqliteWorker.createLiveQuery(id, channel.port2, statement);
      }
    },
    async ping() {
      console.log("Backend: Ping received");
      return {
        timestamp: Date.now(),
        workerId: backendWorkerId,
      };
    },
    async createStream(ulid, moduleId, moduleUrl, params): Promise<string> {
      if (!state.leafClient) throw new Error("Leaf client not initialized");
      return await state.leafClient.createStreamFromModuleUrl(
        ulid,
        moduleId,
        moduleUrl,
        params || new ArrayBuffer(),
      );
    },
    async sendEvent(streamId: string, event: EventType) {
      if (!state.leafClient) throw "Leaf client not ready";
      await state.leafClient.sendEvent(
        streamId,
        eventCodec.enc(event).buffer as ArrayBuffer,
      );
    },
    async sendEventBatch(streamId, payloads) {
      if (!state.leafClient) throw "Leaf client not ready";
      const encodedPayloads = payloads.map((x) => {
        try {
          return eventCodec.enc(x).buffer as ArrayBuffer;
        } catch (e) {
          throw new Error(
            `Could not encode event: ${JSON.stringify(x, null, "  ")}`,
            { cause: e },
          );
        }
      });
      await state.leafClient.sendEvents(streamId, encodedPayloads);
    },
    async fetchEvents(streamId, offset, limit) {
      if (!state.leafClient) throw "Leaf client not initialized";
      const events = (
        await state.leafClient?.fetchEvents(streamId, { offset, limit })
      )?.map((x) => ({
        ...x,
        stream: streamId,
      }));
      return events;
    },
    async previewSpace(streamId) {
      await sqliteWorkerReady;
      // TODO: Replace with partial loads of space.

      // if (!sqliteWorker) throw new Error("Sqlite worker not initialized");
      // if (!state.leafClient) throw "Leaf client not initialized";
      // const previewMaterializer = new PreviewMaterializer(
      //   streamId,
      //   materializerConfig,
      // );
      // await previewMaterializer.fetchPreviewEvents();
      return new Promise(() => {
        name: "test";
      });
    },
    async uploadImage(bytes, alt?: string) {
      if (!state.agent) throw new Error("Agent not initialized");
      const resp = await state.agent.com.atproto.repo.uploadBlob(
        new Uint8Array(bytes),
      );
      const blobRef = resp.data.blob;
      // Create a record that links to the blob
      const record = {
        $type: "space.roomy.image",
        image: blobRef,
        alt,
      };
      // Put the record in the repository
      const putResponse = await state.agent.com.atproto.repo.putRecord({
        repo: state.agent.assertDid,
        collection: "space.roomy.image",
        rkey: `${Date.now()}`, // Using timestamp as a unique key
        record: record,
      });
      const url = `https://cdn.bsky.app/img/feed_thumbnail/plain/${state.agent.assertDid}/${blobRef.ipld().ref}`;
      return {
        blob: blobRef,
        uri: putResponse.data.uri,
        cid: putResponse.data.cid,
        url,
      };
    },
    async addClient(port) {
      connectMessagePort(port);
    },
    async pauseSubscription(streamId) {
      await state.openSpacesMaterializer?.pauseSubscription(streamId);
    },
    async unpauseSubscription(streamId) {
      await state.openSpacesMaterializer?.unpauseSubscription(streamId);
    },
  });

  // Set up console forwarding to main thread for debugging
  // This intercepts console.log/warn/error/info/debug calls in the SharedWorker
  // and forwards them to the main thread with a [SharedWorker] prefix.
  // This is essential for debugging on Safari where SharedWorker console
  // output is not directly visible in developer tools.
  for (const level of consoleLogLevels) {
    const normalLog = globalThis.console[level];
    globalThis.console[level] = (...args) => {
      normalLog(...args);
      consoleInterface.log(level, args);
    };
  }
}

// Add periodic health check function
let healthCheckInterval: NodeJS.Timeout | null = null;

function setupSqliteHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }

  healthCheckInterval = setInterval(async () => {
    if (!sqliteWorker) return;

    try {
      await sqliteWorker.ping();
    } catch (error) {
      console.error("Backend: SQLite health check failed", error);
      // Could trigger reconnection logic here
    }
  }, 10000); // Check every 10 seconds
}

async function createOauthClient(): Promise<OAuthClient> {
  // Build the client metadata
  let clientMetadata: OAuthClientMetadataInput;
  if (import.meta.env.DEV) {
    // Get the base URL and redirect URL for this deployment
    if (globalThis.location.hostname == "localhost")
      throw new Error("hostname must be 127.0.0.1 if local");
    const baseUrl = new URL(`http://127.0.0.1:${globalThis.location.port}`);
    baseUrl.hash = "";
    baseUrl.pathname = "/";
    const redirectUri = baseUrl.href + "oauth/callback";
    // In dev, we build a development metadata
    clientMetadata = {
      ...atprotoLoopbackClientMetadata(buildLoopbackClientId(baseUrl)),
      redirect_uris: [redirectUri],
      scope: atprotoOauthScope,
      client_id: `http://localhost?redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&scope=${encodeURIComponent(atprotoOauthScope)}`,
    };
  } else {
    // In prod, we fetch the `/oauth-client.json` which is expected to be deployed alongside the
    // static build.
    // native client metadata is not reuqired to be on the same domin as client_id,
    // so it can always use the deployed metadata
    const resp = await fetch(`/oauth-client.json`, {
      headers: [["accept", "application/json"]],
    });
    clientMetadata = await resp.json();
  }

  return workerOauthClient(clientMetadata);
}

async function initializeLeafClient(client: LeafClient) {
  client.on("connect", async () => {
    console.log("Leaf: connected");
  });
  client.on("disconnect", () => {
    console.log("Leaf: disconnected");
    status.leafConnected = false;
    state.personalSpaceMaterializer = undefined;
    state.openSpacesMaterializer?.close();
    state.openSpacesMaterializer = undefined;
  });
  client.on("authenticated", async (did) => {
    console.log("Leaf: authenticated as", did);

    if (!state.agent) throw new Error("ATProto agent not initialized");

    console.log("Now looking for personal stream id");
    // Get the user's personal space ID

    const id = await getPersonalStreamIdCache(did);
    if (id) {
      status.personalStreamId = id;
    } else {
      try {
        const resp1 = await state.agent.com.atproto.repo.getRecord({
          collection: CONFIG.streamNsid,
          repo: did,
          rkey: CONFIG.streamSchemaVersion,
        });
        const existingRecord = resp1.data.value as { id: string };
        status.personalStreamId = existingRecord.id;
        await setPersonalStreamIdCache(did, existingRecord.id);
        console.log("Found existing stream ID from PDS:", existingRecord.id);
      } catch (_) {
        // this catch block creating a new stream needs to be refactored
        // so that it only happens when there definitely is no record
        console.log(
          "Could not find existing stream ID on PDS. Creating new stream!",
        );

        // create a new stream on leaf server
        const personalStreamUlid = ulid();
        const personalStreamId = await client.createStreamFromModuleUrl(
          personalStreamUlid,
          LEAF_MODULE_PERSONAL.id,
          LEAF_MODULE_PERSONAL.url,
          streamParamsCodec.enc({
            streamType: "space.roomy.stream.personal",
            schemaVersion: CONFIG.streamSchemaVersion,
          }).buffer as ArrayBuffer,
        );
        console.log("Created new stream:", personalStreamId);

        // put the stream ID in a record
        const resp2 = await state.agent.com.atproto.repo.putRecord({
          collection: CONFIG.streamNsid,
          record: { id: personalStreamId },
          repo: state.agent.assertDid,
          rkey: CONFIG.streamSchemaVersion,
        });
        if (!resp2.success) {
          throw new Error("Could not create PDS record for personal stream", {
            cause: JSON.stringify(resp2.data),
          });
        }
        status.personalStreamId = personalStreamId;
        await setPersonalStreamIdCache(did, personalStreamId);
      }
    }

    client.subscribe(status.personalStreamId);
    console.log("Subscribed to stream:", status.personalStreamId);

    await sqliteWorkerReady;

    state.personalSpaceMaterializer = new StreamMaterializer(
      status.personalStreamId,
      materializerConfig,
    );
    state.openSpacesMaterializer = new OpenSpacesMaterializer(
      status.personalStreamId,
    );

    status.leafConnected = true;
  });
  client.on("event", (event) => {
    if (event.stream == state.personalSpaceMaterializer?.streamId) {
      state.personalSpaceMaterializer.handleEvents(
        AsyncChannel.single([
          {
            idx: event.idx,
            user: event.user,
            payload: event.payload,
          },
        ]),
      );
    } else {
      state.openSpacesMaterializer?.handleEvent(event);
    }
  });
}

class OpenSpacesMaterializer {
  #liveQueryId: string;
  #streamId: string;
  #spaceMaterializers: Map<string, StreamMaterializer> = new Map();

  constructor(streamId: string) {
    this.#streamId = streamId;
    this.#liveQueryId = crypto.randomUUID();
    this.createLiveQuery();
  }

  get openSpaces(): string[] {
    return [...this.#spaceMaterializers.keys()];
  }

  async pauseSubscription(streamId: string) {
    state.leafClient?.unsubscribe(streamId);
  }

  async unpauseSubscription(streamId: string) {
    if (!state.leafClient) throw "Leaf client not initialized";
    const materializer = this.#spaceMaterializers.get(streamId);
    if (materializer) {
      state.leafClient.subscribe(streamId);
      await materializer.backfillEvents();
    }
  }

  createLiveQuery() {
    if (!sqliteWorker) throw "Sqlite worker not ready";

    const channel = new MessageChannel();
    channel.port1.onmessage = (ev) => {
      const data: LiveQueryMessage = ev.data;
      if ("error" in data) {
        console.warn("Error in spaces list query", data.error);
      } else if ("rows" in data) {
        const spaces = data.rows as { id: string }[];
        this.updateSpaceList(spaces.map(({ id }) => id));
      }
    };

    sqliteWorker.createLiveQuery(
      this.#liveQueryId,
      channel.port2,
      sql`-- backend space list
        select id(e.id) as id from entities e join comp_space on e.id = comp_space.entity
        where stream_id = ${id(this.#streamId)} and hidden = 0
      `,
    );
  }

  updateSpaceList(spaces: string[]) {
    const openSpaceSet = new Set(this.#spaceMaterializers.keys());
    const newSpaceSet = new Set(spaces);
    const spacesToClose = openSpaceSet.difference(newSpaceSet);
    const spacesToOpen = newSpaceSet.difference(openSpaceSet);

    for (const spaceToClose of spacesToClose) {
      this.#spaceMaterializers.delete(spaceToClose);
      state.leafClient?.unsubscribe(spaceToClose);
    }
    for (const spaceToOpen of spacesToOpen) {
      this.#spaceMaterializers.set(
        spaceToOpen,
        new StreamMaterializer(spaceToOpen, materializerConfig),
      );
      state.leafClient?.subscribe(spaceToOpen);
    }
  }

  handleEvent(event: IncomingEvent) {
    const materializer = this.#spaceMaterializers.get(event.stream);
    if (materializer) {
      materializer.handleEvents(
        AsyncChannel.single([
          { idx: event.idx, payload: event.payload, user: event.user },
        ]),
      );
    }
  }

  close() {
    sqliteWorker?.deleteLiveQuery(this.#liveQueryId);
  }
}

export type SqlStatement = {
  sql: string;
  params?: BindingSpec;
  /** If this is true, the query will not be pre-compiled and cached. Use this when you have to
   * substitute strings into the sql query instead of using params, because that will mess up the
   * cache which must be indexed by the SQL. */
  cache?: boolean;
};

export type StreamEvent = {
  idx: number;
  user: string;
  payload: ArrayBuffer;
};

type SqlMaterializer = (
  sqliteWorker: SqliteWorkerInterface,
  agent: Agent,
  streamId: string,
  events: AsyncChannel<StreamEvent[]>,
) => AsyncChannel<{ sqlStatements: SqlStatement[]; latestEvent: number }>;
export type MaterializerConfig = {
  initSql: SqlStatement[];
  materializer: SqlMaterializer;
};

const MATERIALIZER_LOCK = "Materializer";
class StreamMaterializer {
  #streamId: string;
  #latestEvent: number | undefined;
  #queue: AsyncChannel<StreamEvent[]>[] = [];
  #materializer: SqlMaterializer;

  get streamId() {
    return this.#streamId;
  }

  constructor(streamId: string, config: MaterializerConfig) {
    console.log("new materializer for ", streamId);
    if (!state.leafClient) throw "No leaf client";
    if (!status.personalStreamId) throw new Error("No personal stream id");
    this.#streamId = streamId;
    this.#materializer = config.materializer;

    state.leafClient.subscribe(this.#streamId);

    if (!sqliteWorker) throw "No Sqlite worker";

    // Initialize the database schema. This is assumed to be idempotent.
    console.time("initSql");
    sqliteWorker.runSavepoint({ name: "init", items: config.initSql });
    console.timeEnd("initSql");

    // Start backfilling the stream events
    this.backfillEvents();
  }

  async backfillEvents() {
    navigator.locks.request(
      MATERIALIZER_LOCK,
      (async () => {
        if (!state.leafClient) throw "No leaf client";
        if (!sqliteWorker) throw "No Sqlite worker";

        const entry = await db.streamCursors.get(this.#streamId);
        this.#latestEvent = entry?.latestEvent || 0;
        console.log("latestevent", this.#latestEvent);

        statusStartBackfillingStream();

        // Backfill events
        console.time(`finishedBackfill-${this.#streamId}`);
        console.log("Backfilling stream:", this.#streamId);

        const fetchChannel = new AsyncChannel<StreamEvent[]>();

        // Start fetching all the new events and sending them into the fetch channel
        const latestEventBeforeBackfill = this.#latestEvent;
        (async () => {
          let fetchCursor = latestEventBeforeBackfill + 1;
          console.time(`fetchAllBatches-${this.#streamId}`);

          while (true) {
            if (!state.leafClient) throw new Error("Missing leaf client");
            console.time("fetchBatch");

            const batchSize = 2500;
            const newEvents = await state.leafClient.fetchEvents(
              this.#streamId,
              {
                offset: fetchCursor,
                limit: batchSize,
              },
            );

            if (newEvents.length == 0) break;
            fetchChannel.push(newEvents);
            fetchCursor += batchSize;
            console.timeEnd("fetchBatch");
          }

          fetchChannel.finish();
          console.timeEnd(`fetchAllBatches-${this.#streamId}`);
        })();

        await this.#materializeEvents(fetchChannel);

        console.timeEnd(`finishedBackfill-${this.#streamId}`);
        statusDoneBackfillingStream();

        // It's good practice to run optimize every once in a while, so after backfilling feels like
        // a good time.
        sqliteWorker.runQuery(sql`pragma optimize`);
      }).bind(this),
    );
  }

  async handleEvents(channel: AsyncChannel<StreamEvent[]>) {
    navigator.locks.request(
      MATERIALIZER_LOCK,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          // Spawn a task to finish off the queue once we can obtain the lock
          if (this.#queue.length == 0) {
            (async () => {
              // console.log("Starting a task to finish off the queue later.");
              navigator.locks.request(MATERIALIZER_LOCK, async () => {
                while (this.#queue.length > 0) {
                  const queue = [...this.#queue];
                  this.#queue.length = 0;
                  for (const channel of queue) {
                    await this.#materializeEvents(channel);
                  }
                }
                // console.log("Done applying queue");
              });
            })();
          }
          this.#queue.push(channel);
          return;
        }

        // Materialize the event
        await this.#materializeEvents(channel);
      },
    );
  }

  async #materializeEvents(batches: AsyncChannel<StreamEvent[]>) {
    if (!sqliteWorker) throw "No Sqlite worker";
    if (!state.agent) throw "No ATProto agent";
    if (!state.leafClient) throw "No Leaf client";
    if (this.#latestEvent == undefined) throw "latest event not initialized";

    const sqlChannel = this.#materializer(
      sqliteWorker,
      state.agent,
      this.#streamId,
      batches,
    );

    for await (const { sqlStatements, latestEvent } of sqlChannel) {
      try {
        console.time("runMaterializedSql");
        await sqliteWorker.runSavepoint({
          items: sqlStatements,
          name: "batch_materialize",
        });
        console.timeEnd("runMaterializedSql");
        this.#latestEvent = latestEvent;
        await db.streamCursors.put({
          streamId: this.#streamId,
          latestEvent: this.#latestEvent,
        });
        console.log(
          `Materialized to latest event for stream ${this.#streamId}: ${latestEvent}`,
        );
      } catch (e) {
        console.error(
          `Could not materialize events ending in latest event ${latestEvent}`,
        );
        console.error(e);
      }
    }
  }
}
