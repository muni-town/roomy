import type { OAuthSession } from "@atproto/oauth-client";
import { createOauthClient, oauthDb } from "./oauth";
import { db } from "../idb";
import { Agent, AtpAgent } from "@atproto/api";
import { lexicons } from "$lib/lexicons";
import { CONFIG } from "$lib/config";
import { type Batch, type EncodedStreamEvent } from "../types";
import { Deferred } from "$lib/utils/deferred";
import type { ClientStatus, ConnectionStates } from "./types";
import {
  UserDid,
  type Event,
  StreamDid,
  StreamIndex,
  Ulid,
  modules,
  ConnectedSpace,
  newUlid,
  type EventCallback,
  type DecodedStreamEvent,
  AsyncChannel,
  // SDK client
  RoomyClient,
  parseEvents,
} from "@roomy/sdk";
import { encode } from "@atcute/cbor";
import { context } from "@opentelemetry/api";
import type { RoomyClientEvents } from "../../../../../sdk/dist/client/RoomyClient";

/** Handles interaction with ATProto and Leaf, manages state for connection to both,
 * including connecting to and backfilling streams */
export class Client {
  /** SDK client for ATProto/Leaf operations with caching */
  readonly roomy: RoomyClient;
  #state: ClientStatus;
  #connected = new Deferred<ConnectionStates.ConnectedStreams>();

  private constructor(roomy: RoomyClient) {
    this.roomy = roomy;
    this.#state = {
      status: "initialising",
    };
  }

  /** Convenience accessor for the ATProto agent */
  get agent() {
    return this.roomy.agent;
  }

  /** Convenience accessor for the Leaf client */
  get leaf() {
    return this.roomy.leaf;
  }

  /** Handle Leaf disconnect by updating stream connection status */
  #handleDisconnect = () => {
    this.#state = { status: "offline" };
  };

  // get a URL for redirecting to the ATProto PDS for login
  static async login(handle: string) {
    const oauth = await createOauthClient();
    const url = await oauth.authorize(handle, {
      scope: CONFIG.atprotoOauthScope,
    });
    return url.href;
  }

  // authenticate using app password (testing only)
  static async loginWithAppPassword(
    handle: string,
    appPassword: string,
    eventHandlers?: RoomyClientEvents,
  ) {
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

    return Client.fromAgent(atpAgent, eventHandlers);
  }

  // restore previous session or return `undefined` if there was none
  static async restoreSession(
    eventHandlers?: RoomyClientEvents,
  ): Promise<Client | undefined> {
    const [span, ctx] = tracer.startActiveSpan(
      "Restore Client Session",
      (span) => [span, context.active()] as const,
    );

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

    const restoredSession = await tracer.startActiveSpan(
      "Restore Oauth Session",
      {},
      ctx,
      (span) => oauthClient.restore(didEntry.value).finally(() => span.end()),
    );

    const client = await context.bind(ctx, Client.fromSession)(
      restoredSession,
      eventHandlers,
    );

    span.end();
    return client;
  }

  // create new session from query params
  static async oauthCallback(
    params: URLSearchParams,
    eventHandlers?: RoomyClientEvents,
  ) {
    const oauth = await createOauthClient();
    const response = await oauth.callback(params);
    return Client.fromSession(response.session, eventHandlers);
  }

  private static async fromAgent(
    agent: Agent,
    eventHandlers?: RoomyClientEvents,
  ): Promise<Client> {
    const ctx = context.active();
    lexicons.forEach((l) => agent.lex.add(l as any));

    const roomy = await context.bind(ctx, RoomyClient.create)(
      {
        agent,
        leafUrl: CONFIG.leafUrl,
        leafDid: CONFIG.leafServerDid,
        spaceHandleNsid: CONFIG.streamHandleNsid,
        spaceNsid: CONFIG.streamNsid,
      },
      eventHandlers,
    );

    return new Client(roomy);
  }

  static async fromSession(
    session: OAuthSession,
    eventHandlers?: RoomyClientEvents,
  ) {
    const ctx = context.active();
    await db.kv.put({ key: "did", value: session.did });
    const agent = new Agent(session);
    return context.bind(ctx, Client.fromAgent)(agent, eventHandlers);
  }

  get status() {
    return this.#state.status;
  }

  get connected() {
    return this.#connected.promise;
  }

  /** Connect to the list of spaces. */
  async connect(
    personalSpace: ConnectedSpace,
    eventChannel: AsyncChannel<Batch.Events>,
    streamList: Map<StreamDid, StreamIndex>,
  ) {
    console.debug("Client connecting", streamList);

    const streams = new Map<StreamDid, ConnectedSpace>();
    const failed: StreamDid[] = [];

    for await (const [streamId, _upToEventId] of streamList.entries()) {
      try {
        const space = await ConnectedSpace.connect({
          client: this.roomy,
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

    this.#state = {
      status: "connected",
      personalSpace: personalSpace,
      eventChannel: eventChannel,
      streams,
    };
    this.#connected.resolve(this.#state);

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
    if (this.#state.status !== "connected")
      throw new Error(
        "No event channel: Client is not connected. Status: " +
          this.#state.status,
      );
    return this.#state.eventChannel;
  }

  async connectSpaceStream(streamId: StreamDid, _idx: StreamIndex) {
    if (this.#state.status !== "connected")
      throw new Error("Client must be connected to add new space stream");

    const alreadyConnected = this.#state.streams.get(streamId);
    if (alreadyConnected) return;

    const space = await ConnectedSpace.connect({
      client: this.roomy,
      streamDid: streamId,
      module: modules.space,
    });

    // Subscribe with callback that pushes to eventChannel
    const callback = this.#createEventCallback(this.eventChannel, streamId);
    // First get metadata to find latest index, then subscribe from there
    const latest = await space.subscribeMetadata(callback, 0);
    await space.unsubscribe();
    await space.subscribe(callback, latest);

    this.#state.streams.set(streamId, space);

    return;
  }

  async createSpaceStream() {
    if (this.#state.status !== "connected")
      throw new Error("Client must be connected to add new space stream");

    const newSpace = await ConnectedSpace.create(
      {
        client: this.roomy,
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
    this.#state.streams.set(newSpace.streamDid, newSpace);

    return newSpace.streamDid;
  }

  get personalSpace() {
    if (this.#state.status === "connected") return this.#state.personalSpace;
    else return undefined;
  }

  get personalSpaceId() {
    if (this.#state.status === "connected")
      return this.#state.personalSpace.streamDid;
    else return undefined;
  }

  async createPersonalSpace(
    eventChannel: AsyncChannel<Batch.Events>,
  ): Promise<ConnectedSpace> {
    const space = await ConnectedSpace.create(
      {
        client: this.roomy,
        module: modules.personal,
      },
      UserDid.assert(this.agent.assertDid),
    );

    // Subscribe with callback that pushes to eventChannel
    const callback = this.#createEventCallback(eventChannel, space.streamDid);
    await space.subscribe(callback);

    return space;
  }

  async ensurePersonalSpace(
    eventChannel: AsyncChannel<Batch.Events>,
  ): Promise<ConnectedSpace> {
    if (this.personalSpace) return this.personalSpace;

    console.debug("Looking for personal stream id with", {
      rkey: CONFIG.streamSchemaVersion,
    });

    const space = await this.roomy.connectPersonalSpace(
      CONFIG.streamSchemaVersion,
    );

    const callback = this.#createEventCallback(eventChannel, space.streamDid);
    await space.subscribe(callback);

    return space;
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
    await this.leaf.sendEvents(spaceId, encodedPayloads);
  }

  async fetchEvents(
    spaceId: string,
    start: number,
    limit: number,
  ): Promise<EncodedStreamEvent[]> {
    const resp = await this.leaf?.query(spaceId, {
      name: "events",
      params: {},
      limit,
      start,
    });
    const events = parseEvents(resp);
    return events;
  }

  async lazyLoadRoom(spaceId: StreamDid, roomId: Ulid, end?: StreamIndex) {
    await this.#connected.promise;
    if (this.#state.status !== "connected")
      throw new Error("Client not connected");

    const space = this.#state.streams.get(spaceId);
    if (!space) throw new Error("Could not find space in connected streams");
    const ROOM_FETCH_BATCH_SIZE = 100;
    const events = await space.lazyLoadRoom(roomId, ROOM_FETCH_BATCH_SIZE, end);

    // Push fetched events to eventChannel for materialization
    if (events.length > 0) {
      this.eventChannel.push({
        status: "events",
        batchId: newUlid(),
        streamId: spaceId,
        events,
        priority: "priority",
      });
    }
  }

  async logout() {
    await db.kv.delete("did");
    await oauthDb.session.clear();
    await oauthDb.state.clear();
  }
}
