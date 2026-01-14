import type { OAuthSession } from "@atproto/oauth-client";
import { createOauthClient } from "./oauth";
import { db, personalStream } from "../idb";
import { Agent, AtpAgent, BlobRef } from "@atproto/api";
import { lexicons } from "$lib/lexicons";
import { LeafClient } from "@muni-town/leaf-client";
import { CONFIG } from "$lib/config";
import {
  type StreamIndex,
  type Batch,
  type EncodedStreamEvent,
} from "../types";
import { type Profile } from "$lib/types/profile";
import { Deferred } from "$lib/utils/deferred";
import { AsyncChannel } from "../asyncChannel";
import type { StreamConnectionStatus, ConnectionStates } from "./types";
import { ConnectedStream, parseEvents } from "./stream";
import {
  Did,
  UserDid,
  Handle,
  type Event,
  StreamDid,
  type,
  Ulid,
  modules,
} from "@roomy/sdk";
import { encode } from "@atcute/cbor";

/** Handles interaction with ATProto and Leaf, manages state for connection to both,
 * including connecting to and backfilling streams */
export class Client {
  agent: Agent;
  leaf: LeafClient;
  #streamConnection: StreamConnectionStatus;
  #leafAuthenticated = new Deferred();
  #connected = new Deferred<ConnectionStates.ConnectedStreams>();
  #agentStreamHandleCache = new Map<Did, { result: any }>();
  #agentProfileCache = new Map<string, { result: any }>();

  constructor(agent: Agent, leaf: LeafClient) {
    this.agent = agent;
    this.leaf = leaf;
    this.#streamConnection = {
      status: "initialising",
    };
    this.setLeafHandlers();
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

      const leaf = new LeafClient(CONFIG.leafUrl, async () => {
        const resp = await agent?.com.atproto.server.getServiceAuth({
          aud: CONFIG.leafServerDid,
          lxm: "town.muni.leaf.authenticate",
        });
        if (!resp) throw "Error authenticating for leaf server";
        return resp.data.token;
      });

      return new Client(agent, leaf);
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
    try {
      const streamInfo = await this.leaf.streamInfo(streamId);
      if (!streamInfo) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Connect to the list of spaces. */
  async connect(
    personalStream: ConnectedStream,
    streamList: Map<StreamDid, StreamIndex>,
  ) {
    console.debug("Client connecting", streamList);

    const streams = new Map<StreamDid, ConnectedStream>();
    const failed: StreamDid[] = [];

    for await (const [streamId, upToEventId] of streamList.entries()) {
      try {
        const stream = await ConnectedStream.connect({
          user: UserDid.assert(this.agent.assertDid),
          leaf: this.leaf,
          id: streamId,
          idx: upToEventId,
          eventChannel: personalStream.eventChannel,
          module: modules.space,
        });
        streams.set(streamId, stream);
      } catch (e) {
        console.error("Stream may not exist:", streamId, e);
        failed.push(streamId);
      }
    }

    this.#streamConnection = {
      status: "connected",
      personalStream: personalStream,
      eventChannel: personalStream.eventChannel,
      streams,
    };
    this.#connected.resolve(this.#streamConnection);

    console.debug("(init.3) Client connected");

    return { streams, failed };
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
    const targetDid = did || this.agent.did;
    if (!targetDid) throw new Error("ATProto client doesn't have a DID");
    const resp = await this.agent.getProfile({ actor: targetDid });
    return resp.success
      ? {
          id: resp.data.did,
          avatar: resp.data.avatar,
          banner: resp.data.banner,
          description: resp.data.description,
          displayName: resp.data.displayName,
          handle: resp.data.handle,
        }
      : undefined;
  }

  async connectSpaceStream(streamId: StreamDid, idx: StreamIndex) {
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to add new space stream");
    await this.#leafAuthenticated.promise;

    const alreadyConnected = this.#streamConnection.streams.get(streamId);
    if (alreadyConnected) return;

    const stream = await ConnectedStream.connect({
      user: UserDid.assert(this.agent.assertDid),
      leaf: this.leaf,
      id: streamId,
      idx,
      eventChannel: this.eventChannel,
      module: modules.space,
    });

    const latest = await stream.backfillMetadata();
    stream.subscribeEvents(latest);

    this.#streamConnection.streams.set(streamId, stream);

    return;
  }

  async createSpaceStream() {
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to add new space stream");
    await this.#leafAuthenticated.promise;

    const newStream = await ConnectedStream.create({
      user: UserDid.assert(this.agent.assertDid),
      leaf: this.leaf,
      eventChannel: this.eventChannel,
      module: modules.space,
    });

    await newStream.backfillAndSubscribeAllEvents();

    console.debug("Successfully created space stream:", newStream.id);

    // add to stream connection map
    this.#streamConnection.streams.set(newStream.id, newStream);

    return newStream.id as StreamDid;
  }

  get personalStream() {
    if (this.#streamConnection.status === "connected")
      return this.#streamConnection.personalStream;
    else return undefined;
  }

  get personalStreamId() {
    if (this.#streamConnection.status === "connected")
      return this.#streamConnection.personalStream.id;
    else return undefined;
  }

  async createPersonalStream(
    eventChannel: AsyncChannel<Batch.Events>,
  ): Promise<ConnectedStream> {
    await this.#leafAuthenticated.promise;

    return await ConnectedStream.create({
      user: UserDid.assert(this.agent.assertDid),
      leaf: this.leaf,
      eventChannel,
      module: modules.personal,
    });
  }

  async ensurePersonalStream(
    eventChannel: AsyncChannel<Batch.Events>,
  ): Promise<ConnectedStream> {
    if (this.personalStream) return this.personalStream;
    await this.#leafAuthenticated.promise;

    console.debug("Looking for personal stream id with", {
      rkey: CONFIG.streamSchemaVersion,
    });

    // TODO: Caching the personal stream ID causes problems when it gets cached and the PDS record
    // has changed because the app will just get stuck loading forever trying to get the stream that
    // doesn't exist. For now we just disable loading the stream ID from cache. I don't think it's
    // unreasonable to just fetch this on startup for now.

    // let id = await personalStream.getIdCache(this.agent.assertDid);

    let attempts = 0;
    let errors: any[] = [];
    let stream: ConnectedStream | null = null;
    while (!stream) {
      if (attempts > 2) throw errors;
      try {
        const getResponse = await this.agent.com.atproto.repo.getRecord({
          collection: CONFIG.streamNsid,
          repo: this.agent.assertDid,
          rkey: CONFIG.streamSchemaVersion,
        });
        const existingRecord = getResponse.data.value as { id: StreamDid };
        await personalStream.setIdCache(
          this.agent.assertDid,
          existingRecord.id,
        );
        stream = await ConnectedStream.connect({
          user: UserDid.assert(this.agent.assertDid),
          leaf: this.leaf,
          id: existingRecord.id as StreamDid,
          idx: 0 as StreamIndex,
          eventChannel,
          module: modules.personal,
        });
      } catch (e) {
        if ((e as any).error === "RecordNotFound") {
          console.info(
            "Could not find existing stream ID on PDS. Creating new stream!",
          );

          // create a new stream on leaf server
          stream = await this.createPersonalStream(eventChannel);

          console.debug("Putting record to PDS");

          // put the stream ID in a record
          const putResponse = await this.agent.com.atproto.repo.putRecord({
            collection: CONFIG.streamNsid,
            record: { id: stream.id },
            repo: this.agent.assertDid,
            rkey: CONFIG.streamSchemaVersion,
          });
          if (!putResponse.success) {
            errors.push(
              new Error("Could not create PDS record for personal stream", {
                cause: JSON.stringify(putResponse.data),
              }),
            );
          }

          await personalStream.setIdCache(this.agent.assertDid, stream.id);
        } else if ((e as Error).message.includes("Stream does not exist")) {
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

    stream.backfillAndSubscribeAllEvents();

    // Get the module id for this stream to check whether or not we need to update the module.
    const streamInfo = await this.leaf.streamInfo(stream.id);

    return stream;
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

    const stream = this.#streamConnection.streams.get(streamId);
    if (!stream) throw new Error("Could not find stream in connected streams");
    const ROOM_FETCH_BATCH_SIZE = 100;
    await stream.lazyLoadRoom(roomId, ROOM_FETCH_BATCH_SIZE, end);
  }

  async uploadToPDS(
    bytes: ArrayBuffer,
    opts?: { alt?: string; mimetype?: string },
  ): Promise<{
    blob: ReturnType<BlobRef["toJSON"]>;
    uri: string;
  }> {
    const resp = await this.agent.com.atproto.repo.uploadBlob(
      new Uint8Array(bytes),
    );
    const blobRef = resp.data.blob;
    if (opts?.mimetype) blobRef.mimeType = opts?.mimetype;
    const blobInfo = {
      blob: blobRef.toJSON(),
      uri: `atblob://${this.agent.assertDid}/${blobRef.ref}`,
    };

    // Create a record that links to the blob
    const record = {
      $type: "space.roomy.upload.v0",
      image: blobRef,
      alt: opts?.alt,
    };
    // Put the record in the repository
    await this.agent.com.atproto.repo.putRecord({
      repo: this.agent.assertDid,
      collection: "space.roomy.upload.v0",
      rkey: `${Date.now()}`, // Using timestamp as a unique key
      record: record,
    });
    return blobInfo;
  }

  async removeStreamHandleRecord() {
    const resp = await this.agent.com.atproto.repo.deleteRecord({
      collection: CONFIG.streamHandleNsid,
      repo: this.agent.assertDid,
      rkey: "self",
    });
    if (!resp.success) throw "Error deleting stream handle record on PDS";
  }

  private async getProfileCached(actor: string) {
    const cached = this.#agentProfileCache.get(actor);
    if (cached) return cached.result;

    const resp = await this.agent.getProfile({
      actor,
    });
    this.#agentProfileCache.set(actor, { result: resp });

    return resp;
  }

  async resolveHandleForSpace(
    spaceId: StreamDid,
    handleAccountDid: UserDid,
  ): Promise<Handle | undefined> {
    try {
      const resp = await this.getProfileCached(handleAccountDid);
      const handle = resp.data.handle as Handle;
      const did = handleAccountDid;
      const resolvedSpaceId = (await this.resolveSpaceId(did))?.spaceId;
      if (resolvedSpaceId == spaceId) {
        return handle;
      }
    } catch (e) {
      console.warn("error while resolving handle for space", e);
      return undefined;
    }
  }

  private resolveIdType(spaceDidOrHandle: StreamDid | Did | Handle) {
    const didParsed = Did(spaceDidOrHandle);
    if (!(didParsed instanceof type.errors)) return "did";
    const handleParsed = Handle(spaceDidOrHandle);
    if (!(handleParsed instanceof type.errors)) return "handle";
    else throw new Error("Invalid ID: " + spaceDidOrHandle);
  }

  private async resolveDidFromHandle(handle: Handle): Promise<UserDid> {
    const type = this.resolveIdType(handle);
    if (type === "handle") {
      try {
        const profile = await this.getProfileCached(handle as Handle);
        return profile.data.did;
      } catch (e) {
        console.warn("Error resolving DID from handle", handle, e);
        throw e;
      }
    } else throw new Error("Invalid type for DID resolution");
  }

  async getSpaceInfo(
    streamDid: StreamDid,
  ): Promise<{ name?: string; avatar?: string } | undefined> {
    try {
      const resp = await this.leaf.query(streamDid, {
        name: "space_info",
        params: {},
      });
      let row = resp[0];
      if (!row) return;
      let name =
        row.name?.$type == "muni.town.sqliteValue.text"
          ? row.name.value
          : undefined;
      let avatar =
        row.avatar?.$type == "muni.town.sqliteValue.text"
          ? row.avatar.value
          : undefined;
      return { name, avatar };
    } catch (error) {
      console.error("Failed to load space info", { streamDid, error });
      return;
    }
  }

  async resolveSpaceId(spaceIdOrHandle: StreamDid | Handle): Promise<{
    spaceId: StreamDid;
    handle?: Handle;
    did?: UserDid;
  }> {
    const type = this.resolveIdType(spaceIdOrHandle);

    if (type === "handle") {
      try {
        const did = await this.resolveDidFromHandle(spaceIdOrHandle);
        const spaceIdFromHandle = await this.getStreamHandleRecordCached(did);
        if (!spaceIdFromHandle) throw "Could not resolve space ID from handle";
        return {
          spaceId: spaceIdFromHandle!,
          handle: type === "handle" ? (spaceIdOrHandle as Handle) : undefined,
          did,
        };
      } catch (e) {
        console.warn(
          "Error resolving space from identifier",
          spaceIdOrHandle,
          e,
        );
        throw e;
      }
    } else {
      return { spaceId: spaceIdOrHandle as StreamDid };
    }
  }

  /** Some streams have a handle configured as an alias via a PDS record that verifies the mapping.
   * This method fetches that record, with caching, and returns the associated stream ID and DID.
   */
  private async getStreamHandleRecordCached(
    did: Did,
  ): Promise<StreamDid | undefined> {
    const cached = this.#agentStreamHandleCache.get(did);
    if (cached) return cached.result;

    try {
      const resp = await this.agent.com.atproto.repo.getRecord(
        {
          collection: CONFIG.streamHandleNsid,
          repo: did,
          rkey: "self",
        },
        {
          headers: {
            "atproto-proxy": `${did}#atproto_pds`,
          },
        },
      );

      const verifiedSpaceId = resp.data.value?.id
        ? (resp.data.value.id as StreamDid)
        : undefined;

      if (verifiedSpaceId) {
        const exists = await this.checkStreamExists(verifiedSpaceId);
        if (!exists) {
          console.warn(
            "Stream handle record points to non-existing stream, returning undefined",
          );
          this.#agentStreamHandleCache.set(did, { result: undefined });
          return undefined;
        }
      }

      this.#agentStreamHandleCache.set(did, { result: verifiedSpaceId });
      return verifiedSpaceId;
    } catch (e) {
      console.warn(
        "Could not get stream handle record, most likely does not exist",
        e,
      );
      this.#agentStreamHandleCache.set(did, { result: undefined });
      return undefined;
    }
  }

  async createStreamHandleRecord(spaceId: string) {
    const resp = await this.agent.com.atproto.repo.putRecord({
      collection: CONFIG.streamHandleNsid,
      repo: this.agent.assertDid,
      rkey: "self",
      record: {
        id: spaceId,
      },
    });
    if (!resp.success) throw "Error creating stream handle record on PDS";
  }

  logout() {
    db.kv.delete("did");
  }
}
