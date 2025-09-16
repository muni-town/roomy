/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference lib="webworker" />

import { LeafClient, type IncomingEvent } from "@muni-town/leaf-client";
import type {
  BackendInterface,
  BackendStatus,
  SqliteWorkerInterface,
} from "./index";
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
import {
  config as materializerConfig,
  eventCodec,
  type EventType,
} from "./materializer";
import { workerOauthClient } from "./oauth";
import type { LiveQueryMessage } from "$lib/setup-sqlite";
import { Hash } from "./encoding";

// TODO: figure out why refreshing one tab appears to cause a re-render of the spaces list live
// query in the other tab.

/**
 * Check whether or not we are executing in a shared worker.
 *
 * On platforms like Android chrome where SharedWorkers are not available this script will run as a
 * dedicated worker instead of a shared worker.
 * */
const isSharedWorker = "SharedWorkerGlobalScope" in globalThis;

const status = reactiveWorkerState<BackendStatus>(
  new BroadcastChannel("backend-status"),
  true,
);

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

// TODO: This might be a horrible local storage shim. I don't know how it handles multiple tabs
// open. Works for now... 🤞 We just need it so that the atproto/oauth-client-browser doesn't panic
// because localStorage isn't defined.
globalThis.localStorage = {
  data: {} as { [key: string]: string },
  persist() {
    db.kv.put({ key: "localStorageShim", value: JSON.stringify(this.data) });
  },
  clear() {
    this.data = {};
  },
  getItem(s: string): string | null {
    return this.data[s] || null;
  },
  key(idx: number): string | null {
    return (Object.values(this.data)[idx] as string | undefined) || null;
  },
  get length(): number {
    return Object.values(this.data).length;
  },
  removeItem(key: string) {
    this.data[key] = undefined;
    this.persist();
  },
  setItem(key: string, value: string) {
    this.data[key] = value;
    this.persist();
  },
};

let sqliteWorker: SqliteWorkerInterface | undefined;
let setSqliteWorkerReady = () => {};
const sqliteWorkerReady = new Promise(
  (r) => (setSqliteWorkerReady = r as () => void),
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
          new LeafClient("http://localhost:5530", async () => {
            const resp = await this.agent?.com.atproto.server.getServiceAuth({
              aud: "did:web:localhost:5530",
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

const liveQueries: Map<
  string,
  { port: MessagePort; sql: string; params?: BindingSpec }
> = new Map();
(globalThis as any).liveQueries = liveQueries;

function connectMessagePort(port: MessagePortApi) {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  messagePortInterface<BackendInterface, {}>(port, {
    async getProfile(did) {
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
    },
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
    async runQuery(sql: string) {
      await sqliteWorkerReady;
      if (!sqliteWorker) throw new Error("Sqlite worker not initialized");
      return await sqliteWorker.runQuery(sql);
    },
    async createLiveQuery(id, port, sql, params) {
      liveQueries.set(id, { port, sql, params });
      const channel = new MessageChannel();
      channel.port1.onmessage = (ev) => {
        port.postMessage(ev.data);
      };
      navigator.locks.request(id, () => {
        // When we obtain a lock to the query ID, that means that the query is no longer in
        // use and we can delete it.
        liveQueries.delete(id);
        sqliteWorker?.deleteLiveQuery(id);
      });
      await sqliteWorkerReady;
      if (!sqliteWorker) throw new Error("Sqlite worker not initialized");
      return await sqliteWorker.createLiveQuery(id, channel.port2, sql, params);
    },
    async dangerousCompletelyDestroyDatabase({ yesIAmSure }) {
      if (!yesIAmSure) throw "You need to be sure";
      if (!sqliteWorker) throw "Sqlite worker not initialized";
      await sqliteWorker.runQuery("pragma writable_schema = 1");
      await sqliteWorker.runQuery("delete from sqlite_master");
      await sqliteWorker.runQuery("vacuum");
      await sqliteWorker.runQuery("pragma integrity_check");
      await db.streamCursors.clear();
    },
    async setActiveSqliteWorker(messagePort) {
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type
      sqliteWorker = messagePortInterface<{}, SqliteWorkerInterface>(
        messagePort,
        {},
      );
      setSqliteWorkerReady();

      // When a new SQLite worker is created we need to make sure that we re-create all of the
      // live queries that were active on the old worker.
      for (const [id, { port, sql, params }] of liveQueries.entries()) {
        console.log("recreating live query", sql);
        const channel = new MessageChannel();
        channel.port1.onmessage = (ev) => {
          port.postMessage(ev.data);
        };
        sqliteWorker.createLiveQuery(id, channel.port2, sql, params);
      }
    },
    async createStream(moduleId, moduleUrl, params): Promise<string> {
      if (!state.leafClient) throw new Error("Leaf client not initialized");
      return await state.leafClient.createStreamFromModuleUrl(
        moduleId,
        moduleUrl,
        params || new ArrayBuffer(),
      );
    },
    async sendEvent(streamId: string, event: EventType) {
      console.log(event);
      if (!state.leafClient) throw "Leaf client not ready";
      console.log(eventCodec.dec(eventCodec.enc(event)));
      await state.leafClient.sendEvent(
        streamId,
        eventCodec.enc(event).buffer as ArrayBuffer,
      );
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
  });
}

async function createOauthClient(): Promise<OAuthClient> {
  // Build the client metadata
  let clientMetadata: OAuthClientMetadataInput;
  if (import.meta.env.DEV) {
    // Get the base URL and redirect URL for this deployment
    if (globalThis.location.hostname == "localhost")
      globalThis.location.hostname = "127.0.0.1";
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

const personalModuleId =
  "74191e22741f299ae69b9f234b31832397ee29c18974eb82a934df827aa0516a";
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

    // Get the user's personal space ID
    let streamId: string;
    try {
      const resp1 = await state.agent.com.atproto.repo.getRecord({
        collection: "space.roomy.stream",
        repo: did,
        rkey: "self",
      });
      const existingRecord = resp1.data.value as { id: string };
      streamId = existingRecord.id;
      console.log("Found existing stream ID from PDS:", streamId);
    } catch (_) {
      console.log("Could not find existing stream ID on PDS");
      streamId = await client.createStreamFromModuleUrl(
        personalModuleId,
        "/leaf_module_personal.wasm",
        new ArrayBuffer(),
      );
      console.log("Created new stream:", streamId);
      const resp2 = await state.agent.com.atproto.repo.putRecord({
        collection: "space.roomy.stream",
        record: { id: streamId, version: 1 },
        repo: state.agent.assertDid,
        rkey: "self",
      });
      if (!resp2.success) {
        throw new Error("Could not create PDS record for personal stream", {
          cause: JSON.stringify(resp2.data),
        });
      }
    }

    status.personalStreamId = streamId;
    client.subscribe(streamId);
    console.log("Subscribed to stream:", streamId);

    await sqliteWorkerReady;

    state.personalSpaceMaterializer = new StreamMaterializer(
      streamId,
      materializerConfig,
    );
    state.openSpacesMaterializer = new OpenSpacesMaterializer(streamId);

    status.leafConnected = true;
  });
  client.on("event", (event) => {
    if (event.stream == state.personalSpaceMaterializer?.streamId) {
      state.personalSpaceMaterializer.handleEvent(event);
    }
    state.openSpacesMaterializer?.handleEvent(event);
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

  createLiveQuery() {
    if (!sqliteWorker) throw "Sqlite worker not ready";

    const channel = new MessageChannel();
    channel.port1.onmessage = (ev) => {
      const data: LiveQueryMessage = ev.data;
      if ("error" in data) {
        console.warn("Error in spaces list query", data.error);
      } else if ("rows" in data) {
        const spaces = data.rows as { id: Uint8Array }[];
        this.updateSpaceList(spaces.map(({ id }) => Hash.dec(id)));
      }
    };

    sqliteWorker.createLiveQuery(
      this.#liveQueryId,
      channel.port2,
      "select id from spaces where stream = ? and hidden = 0",
      [Hash.enc(this.#streamId)],
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
      materializer.handleEvent(event);
    }
  }

  close() {
    sqliteWorker?.deleteLiveQuery(this.#liveQueryId);
  }
}

export type SqlStatement = {
  sql: string;
  params?: BindingSpec;
};

export type StreamEvent = {
  idx: number;
  user: string;
  payload: ArrayBuffer;
};

export type MaterializerConfig = {
  initSql: SqlStatement[];
  materializer: (streamId: string, event: StreamEvent) => SqlStatement[];
};

class StreamMaterializer {
  #streamid: string;
  #backfilling = true;
  #queue: StreamEvent[] = [];
  #latestEvent: number | undefined;
  #materializer: (streamId: string, event: StreamEvent) => SqlStatement[];

  get streamId() {
    return this.#streamid;
  }

  constructor(streamId: string, config: MaterializerConfig) {
    console.log("new materializer for ", streamId);
    if (!state.leafClient) throw "No leaf client";
    this.#streamid = streamId;
    this.#materializer = config.materializer;

    state.leafClient.subscribe(this.#streamid);

    // Start backfilling the stream events
    this.#backfilling = true;
    (async () => {
      if (!state.leafClient) throw "No leaf client";
      if (!sqliteWorker) throw "No Sqlite worker";
      const entry = await db.streamCursors.get(this.#streamid);
      this.#latestEvent = entry?.latestEvent || 0;
      console.log("latestevent", this.#latestEvent);

      // Initialize the database if we haven't processed any events yet
      if (this.#latestEvent == 0) {
        for (const { sql, params } of config.initSql) {
          await sqliteWorker.runQuery(sql, params);
        }
      }

      // Backfill events
      console.log("Backfilling stream:", this.#streamid);
      let iteration = 0;
      while (true) {
        iteration += 1;
        const newEvents = await state.leafClient.fetchEvents(this.#streamid, {
          offset: this.#latestEvent + 1,
          limit: Math.min(100 + 100 * iteration, 1000),
        });
        console.log(`    Fetched batch of ${newEvents.length} events`);
        for (const event of newEvents) {
          await this.#materializeEvent(event);
        }
        if (newEvents.length == 0) break;
      }

      // Finish off any events that have come in while we are backfilling
      while (true) {
        const event = this.#queue.shift();
        if (!event) break;
        await this.#materializeEvent(event);
      }

      console.log("Done backfilling");
      this.#backfilling = false;
    }).bind(this)();
  }

  async handleEvent(event: StreamEvent) {
    // If we're in the middle of backfilling
    if (this.#backfilling) {
      // Queue this event for later
      this.#queue.push(event);
    } else {
      // Materialize the event
      await this.#materializeEvent(event);
    }
  }

  async #materializeEvent(event: StreamEvent) {
    if (!sqliteWorker) throw "No Sqlite worker";
    if (this.#latestEvent == undefined) throw "latest event not initialized";
    if (event.idx != (this.#latestEvent || 0) + 1) throw "Unexpected event IDX";

    for (const { sql, params } of this.#materializer(this.#streamid, event)) {
      try {
        await sqliteWorker.runQuery(sql, params);
      } catch (e) {
        console.warn(
          `Could not materialize event ${event.idx} in stream ${this.#streamid}`,
        );
        console.warn(e);
      }
    }
    this.#latestEvent += 1;
    await db.streamCursors.put({
      streamId: this.#streamid,
      latestEvent: this.#latestEvent,
    });
  }
}
