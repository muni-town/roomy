import type { OAuthSession } from "@atproto/oauth-client";
import { createOauthClient } from "./oauth";
import { db, personalStream } from "../idb";
import { Agent, AtpAgent } from "@atproto/api";
import { lexicons } from "$lib/lexicons";
import { CONFIG } from "$lib/config";
import { type Batch, type EncodedStreamEvent } from "../types";
import { type Profile } from "$lib/types/profile";
import { Deferred } from "$lib/utils/deferred";
import { AsyncChannel } from "../asyncChannel";
import type { StreamConnectionStatus, ConnectionStates } from "./types";
import {
  Did,
  UserDid,
  Handle,
  type Event,
  StreamDid,
  StreamIndex,
  type,
  Ulid,
  modules,
  ConnectedSpace,
  newUlid,
  type EventCallback,
  type DecodedStreamEvent,
  // SDK client
  RoomyClient,
  getPersonalStreamId,
  savePersonalStreamId,
} from "@roomy/sdk";
import { encode } from "@atcute/cbor";
import type { SqlRows } from "@muni-town/leaf-client";

/** Handles interaction with ATProto and Leaf, manages state for connection to both,
 * including connecting to and backfilling streams */
export class Client {
  /** SDK client for ATProto/Leaf operations with caching */
  roomy: RoomyClient;
  #streamConnection: StreamConnectionStatus;
  #leafAuthenticated = new Deferred();
  #connected = new Deferred<ConnectionStates.ConnectedStreams>();

  constructor(roomy: RoomyClient) {
    this.roomy = roomy;
    this.#streamConnection = {
      status: "initialising",
    };
    this.setLeafHandlers();
  }

  /** Convenience accessor for the ATProto agent */
  get agent() {
    return this.roomy.agent;
  }

  /** Convenience accessor for the Leaf client */
  get leaf() {
    return this.roomy.leaf;
  }

  // get a URL for redirecting to the ATProto PDS for login
  static async login(handle: string) {
    const oauth = await createOauthClient();
    const url = await oauth.authorize(handle, {
      scope: CONFIG.atprotoOauthScope,
    });
    return url.href;
  }

  // authenticate using app password (testing only)
  static async loginWithAppPassword(handle: string, appPassword: string) {
    const atpAgent = new AtpAgent({ service: "https://bsky.social" });

    try {
      await atpAgent.login({
        identifier: handle,
        password: appPassword,
      });
    } catch (error) {
      console.error("Client.loginWithAppPassword: Login failed", error);
      throw error;
    }

    if (!atpAgent.did) {
      throw new Error("Failed to authenticate with app password");
    }

    // Store DID for consistency with OAuth flow
    await db.kv.put({ key: "did", value: atpAgent.did });

    return Client.fromAgent(atpAgent);
  }

  // restore previous session or return `undefined` if there was none
  static async new(): Promise<Client | undefined> {
    if (CONFIG.testingAppPassword && CONFIG.testingHandle) {
      console.debug("Using app password authentication for testing");
      return Client.loginWithAppPassword(
        CONFIG.testingHandle,
        CONFIG.testingAppPassword,
      );
    }

    // Standard OAuth flow
    const oauthClient = await createOauthClient();

    // if there's a stored DID and no session yet, try to restore the session
    const didEntry = await db.kv.get("did");
    if (!didEntry) return;

    const restoredSession = await oauthClient.restore(didEntry.value);
    return Client.fromSession(restoredSession);
  }

  // create new session from query params
  static async oauthCallback(params: URLSearchParams) {
    const oauth = await createOauthClient();
    const response = await oauth.callback(params);
    return Client.fromSession(response.session);
  }

  private static async fromAgent(agent: Agent) {
    try {
      lexicons.forEach((l) => agent.lex.add(l as any));

      const roomy = new RoomyClient({
        agent,
        leafUrl: CONFIG.leafUrl,
        leafDid: CONFIG.leafServerDid,
        streamHandleNsid: CONFIG.streamHandleNsid,
      });

      return new Client(roomy);
    } catch (e) {
      console.error(e);
      throw new Error("Failed to create client");
    }
  }

  static async fromSession(session: OAuthSession) {
    try {
      await db.kv.put({ key: "did", value: session.did });
      const agent = new Agent(session);
      return Client.fromAgent(agent);
    } catch (e) {
      console.error(e);
      // db.kv.delete("did");
      throw new Error("Failed to create client from session");
    }
  }

  get status() {
    return this.#streamConnection.status;
  }

  get connected() {
    return this.#connected.promise;
  }

  async checkStreamExists(streamId: StreamDid) {
    return this.roomy.checkStreamExists(streamId);
  }

  /** Connect to the list of spaces. */
  async connect(
    personalStream: ConnectedSpace,
    eventChannel: AsyncChannel<Batch.Events>,
    streamList: Map<StreamDid, StreamIndex>,
  ) {
    console.debug("Client connecting", streamList);

    const streams = new Map<StreamDid, ConnectedSpace>();
    const failed: StreamDid[] = [];

    for await (const [streamId, _upToEventId] of streamList.entries()) {
      try {
        const space = await ConnectedSpace.connect({
          agent: this.agent,
          leaf: this.leaf,
          streamDid: streamId,
          module: modules.space,
        });

        // Subscribe with callback that pushes to eventChannel
        const callback = this.#createEventCallback(eventChannel, streamId);
        // First get metadata to find latest index, then subscribe from there
        const latest = await space.subscribeMetadata(callback, 0);
        await space.unsubscribe();
        space.subscribe(callback, latest);

        streams.set(streamId, space);
      } catch (e) {
        console.error("Stream may not exist:", streamId, e);
        failed.push(streamId);
      }
    }

    this.#streamConnection = {
      status: "connected",
      personalStream: personalStream,
      eventChannel: eventChannel,
      streams,
    };
    this.#connected.resolve(this.#streamConnection);

    console.debug("(init.3) Client connected");

    return { streams, failed };
  }

  /** Create an event callback that pushes to the eventChannel */
  #createEventCallback(
    eventChannel: AsyncChannel<Batch.Events>,
    streamId: StreamDid,
  ): EventCallback {
    return (events: DecodedStreamEvent[], { isBackfill, batchId }) => {
      if (events.length === 0) return;
      eventChannel.push({
        status: "events",
        batchId,
        streamId,
        events,
        priority: isBackfill ? "background" : "priority",
      });
    };
  }

  private get eventChannel() {
    if (this.#streamConnection.status !== "connected")
      throw new Error(
        "No event channel: Client is not connected. Status: " +
          this.#streamConnection.status,
      );
    return this.#streamConnection.eventChannel;
  }

  setLeafHandlers() {
    this.leaf.on("connect", async () => {
      console.info("Leaf: connected");
    });
    this.leaf.on("disconnect", () => {
      console.info("Leaf: disconnected");
      this.#streamConnection = { status: "offline" };
    });
    this.leaf.on("authenticated", async (did) => {
      console.info("Leaf: authenticated as", { did });
      this.#leafAuthenticated.resolve();
    });
  }

  async getProfile(did?: Did): Promise<Profile | undefined> {
    return this.roomy.getProfile(did);
  }

  async connectSpaceStream(streamId: StreamDid, _idx: StreamIndex) {
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to add new space stream");
    await this.#leafAuthenticated.promise;

    const alreadyConnected = this.#streamConnection.streams.get(streamId);
    if (alreadyConnected) return;

    const space = await ConnectedSpace.connect({
      agent: this.agent,
      leaf: this.leaf,
      streamDid: streamId,
      module: modules.space,
    });

    // Subscribe with callback that pushes to eventChannel
    const callback = this.#createEventCallback(this.eventChannel, streamId);
    // First get metadata to find latest index, then subscribe from there
    const latest = await space.subscribeMetadata(callback, 0);
    await space.unsubscribe();
    await space.subscribe(callback, latest);

    this.#streamConnection.streams.set(streamId, space);

    return;
  }

  async createSpaceStream() {
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to add new space stream");
    await this.#leafAuthenticated.promise;

    const newSpace = await ConnectedSpace.create(
      {
        agent: this.agent,
        leaf: this.leaf,
        module: modules.space,
      },
      UserDid.assert(this.agent.assertDid),
    );

    // Subscribe with callback that pushes to eventChannel
    const callback = this.#createEventCallback(
      this.eventChannel,
      newSpace.streamDid,
    );
    await newSpace.subscribe(callback);

    console.debug("Successfully created space stream:", newSpace.streamDid);

    // add to stream connection map
    this.#streamConnection.streams.set(newSpace.streamDid, newSpace);

    return newSpace.streamDid;
  }

  get personalStream() {
    if (this.#streamConnection.status === "connected")
      return this.#streamConnection.personalStream;
    else return undefined;
  }

  get personalStreamId() {
    if (this.#streamConnection.status === "connected")
      return this.#streamConnection.personalStream.streamDid;
    else return undefined;
  }

  async createPersonalStream(
    eventChannel: AsyncChannel<Batch.Events>,
  ): Promise<ConnectedSpace> {
    await this.#leafAuthenticated.promise;

    const space = await ConnectedSpace.create(
      {
        agent: this.agent,
        leaf: this.leaf,
        module: modules.personal,
      },
      UserDid.assert(this.agent.assertDid),
    );

    // Subscribe with callback that pushes to eventChannel
    const callback = this.#createEventCallback(eventChannel, space.streamDid);
    await space.subscribe(callback);

    return space;
  }

  async ensurePersonalStream(
    eventChannel: AsyncChannel<Batch.Events>,
  ): Promise<ConnectedSpace> {
    if (this.personalStream) return this.personalStream;
    await this.#leafAuthenticated.promise;

    const recordConfig = {
      collection: CONFIG.streamNsid,
      schemaVersion: CONFIG.streamSchemaVersion,
    };

    console.debug("Looking for personal stream id with", {
      rkey: CONFIG.streamSchemaVersion,
    });

    let attempts = 0;
    let errors: any[] = [];
    let space: ConnectedSpace | null = null;
    let needsSubscription = false;
    while (!space) {
      if (attempts > 2) throw errors;
      attempts++;
      try {
        const existingStreamDid = await getPersonalStreamId(
          this.agent,
          recordConfig,
        );
        if (!existingStreamDid) {
          throw { error: "RecordNotFound" };
        }
        await personalStream.setIdCache(this.agent.assertDid, existingStreamDid);
        console.debug("Got streamId, connecting...", {
          streamId: existingStreamDid,
        });
        space = await ConnectedSpace.connect({
          agent: this.agent,
          leaf: this.leaf,
          streamDid: existingStreamDid,
          module: modules.personal,
        });
        console.debug("Connected to personal stream");
        needsSubscription = true;
      } catch (e) {
        if ((e as any).error === "RecordNotFound") {
          console.info(
            "Could not find existing stream ID on PDS. Creating new stream!",
          );

          // create a new stream on leaf server (this also subscribes)
          space = await this.createPersonalStream(eventChannel);

          console.debug("Putting record to PDS");

          // put the stream ID in a record
          try {
            await savePersonalStreamId(
              this.agent,
              space.streamDid,
              recordConfig,
            );
          } catch (saveError) {
            errors.push(
              new Error("Could not create PDS record for personal stream", {
                cause: saveError,
              }),
            );
          }

          await personalStream.setIdCache(
            this.agent.assertDid,
            space.streamDid,
          );
        } else if ((e as Error).message?.includes("Stream does not exist")) {
          console.warn("Stream does not exist");
          if (import.meta.env.DEV) {
            console.warn("Deleting stream record off PDS (dev only)");
            // delete record on PDS
            const deleteResponse =
              await this.agent.com.atproto.repo.deleteRecord({
                collection: CONFIG.streamNsid,
                repo: this.agent.assertDid,
                rkey: CONFIG.streamSchemaVersion,
              });
            if (!deleteResponse.success) {
              errors.push(
                new Error("Could not delete PDS record for personal stream", {
                  cause: JSON.stringify(deleteResponse.data),
                }),
              );
            }
          }
          errors.push(e);

          // should create stream on retry
        } else {
          if (e instanceof Error) console.error(e);
          console.error("Error while fetching personal stream record:", e);
          errors.push(e);
        }
      }
    }

    // Subscribe if we connected to existing stream (create already subscribes)
    if (needsSubscription) {
      const callback = this.#createEventCallback(eventChannel, space.streamDid);
      await space.subscribe(callback);
    }

    return space;
  }

  async sendEvent(streamId: string, event: Event) {
    await this.#leafAuthenticated.promise;
    await this.leaf.sendEvent(streamId, encode(event));
  }

  async sendEventBatch(streamId: string, payloads: Event[]) {
    await this.#leafAuthenticated.promise;
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
      streamId,
      payloads,
      encodedPayloads,
    });
    await this.leaf.sendEvents(streamId, encodedPayloads);
  }

  async fetchEvents(
    streamId: string,
    start: number,
    limit: number,
  ): Promise<EncodedStreamEvent[]> {
    await this.#leafAuthenticated.promise;
    const resp = await this.leaf?.query(streamId, {
      name: "events",
      params: {},
      limit,
      start,
    });
    const events = parseEvents(resp);
    return events;
  }

  async lazyLoadRoom(streamId: StreamDid, roomId: Ulid, end?: StreamIndex) {
    await this.#leafAuthenticated.promise;
    await this.#connected.promise;
    if (this.#streamConnection.status !== "connected")
      throw new Error("Stream not connected");

    const space = this.#streamConnection.streams.get(streamId);
    if (!space) throw new Error("Could not find stream in connected streams");
    const ROOM_FETCH_BATCH_SIZE = 100;
    const events = await space.lazyLoadRoom(roomId, ROOM_FETCH_BATCH_SIZE, end);

    // Push fetched events to eventChannel for materialization
    if (events.length > 0) {
      this.eventChannel.push({
        status: "events",
        batchId: newUlid(),
        streamId,
        events,
        priority: "priority",
      });
    }
  }

  async uploadToPDS(
    bytes: ArrayBuffer,
    opts?: { alt?: string; mimetype?: string },
  ) {
    return this.roomy.uploadBlob(bytes, opts);
  }

  async removeStreamHandleRecord() {
    return this.roomy.removeStreamHandleRecord();
  }

  async resolveHandleForSpace(
    spaceId: StreamDid,
    handleAccountDid: UserDid,
  ): Promise<Handle | undefined> {
    return this.roomy.resolveHandleForSpace(spaceId, handleAccountDid);
  }

  async getSpaceInfo(
    streamDid: StreamDid,
  ): Promise<{ name?: string; avatar?: string } | undefined> {
    return this.roomy.getSpaceInfo(streamDid);
  }

  async resolveSpaceId(spaceIdOrHandle: StreamDid | Handle): Promise<{
    spaceId: StreamDid;
    handle?: Handle;
    did?: UserDid;
  }> {
    return this.roomy.resolveSpaceId(spaceIdOrHandle);
  }

  async createStreamHandleRecord(spaceId: string) {
    return this.roomy.createStreamHandleRecord(StreamDid.assert(spaceId));
  }

  logout() {
    db.kv.delete("did");
  }
}

const encodedStreamEvent = type({
  idx: { $type: "'muni.town.sqliteValue.integer'", value: StreamIndex },
  user: { $type: "'muni.town.sqliteValue.text'", value: "string" },
  payload: {
    $type: "'muni.town.sqliteValue.blob'",
    value: type.instanceOf(Uint8Array),
  },
});

export function parseEvents(rows: SqlRows): EncodedStreamEvent[] {
  return rows.map((row) => {
    const result = encodedStreamEvent(row);

    if (result instanceof type.errors) {
      console.error("Could not parse event", result);
      throw new Error("Invalid column names for events response");
    }

    return {
      idx: Number(result.idx.value) as StreamIndex,
      user: UserDid.assert(result.user!.value),
      payload: result.payload?.value,
    };
  });
}
