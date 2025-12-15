import type { OAuthSession } from "@atproto/oauth-client";
import { createOauthClient } from "./oauth";
import { db, personalStream } from "../idb";
import { Agent, AtpAgent, BlobRef, isDid, type Did } from "@atproto/api";
import { lexicons } from "$lib/lexicons";
import { LeafClient } from "@muni-town/leaf-client";
import { CONFIG } from "$lib/config";
import {
  type EventType,
  type StreamHashId,
  type StreamIndex,
  type Batch,
  type EncodedStreamEvent,
  type Handle,
} from "../types";
import { type Profile } from "$lib/types/profile";
import { eventCodec } from "../encoding";
import { Deferred } from "$lib/utils/deferred";
import { AsyncChannel } from "../asyncChannel";
import type { StreamConnectionStatus, ConnectionStates } from "./types";
import { personalModule } from "./modules";
import { ConnectedStream, parseEvents } from "./stream";

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
    console.log(
      "Client.loginWithAppPassword: Starting authentication for",
      handle,
    );
    const atpAgent = new AtpAgent({ service: "https://bsky.social" });

    try {
      await atpAgent.login({
        identifier: handle,
        password: appPassword,
      });
      console.log("Client.loginWithAppPassword: Login successful");
    } catch (error) {
      console.error("Client.loginWithAppPassword: Login failed", error);
      throw error;
    }

    if (!atpAgent.did) {
      throw new Error("Failed to authenticate with app password");
    }

    console.log("Client.loginWithAppPassword: Storing DID", atpAgent.did);
    // Store DID for consistency with OAuth flow
    await db.kv.put({ key: "did", value: atpAgent.did });

    console.log("Client.loginWithAppPassword: Creating client from agent");
    return Client.fromAgent(atpAgent);
  }

  // restore previous session
  static async new() {
    if (CONFIG.testingAppPassword && CONFIG.testingHandle) {
      console.log("Using app password authentication for testing");
      return Client.loginWithAppPassword(
        CONFIG.testingHandle,
        CONFIG.testingAppPassword,
      );
    }

    // Standard OAuth flow
    const oauthClient = await createOauthClient();

    // if there's a stored DID and no session yet, try to restore the session
    const didEntry = await db.kv.get("did");
    if (!didEntry) throw new Error("Failed to retrieve DID from IndexedDB");

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

      console.log("Initialized leaf client");
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

  async checkStreamExists(streamId: StreamHashId) {
    try {
      const streamInfo = await this.leaf.streamInfo(streamId);
      if (!streamInfo) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  async connect(
    personalStream: ConnectedStream,
    streamList: Map<StreamHashId, StreamIndex>,
  ) {
    console.log("Client connecting", streamList);

    const streams = new Map<StreamHashId, ConnectedStream>();
    const failed: StreamHashId[] = [];

    for await (const [streamId, upToEventId] of streamList.entries()) {
      try {
        const stream = await ConnectedStream.connect({
          user: this.agent.assertDid as Did,
          leaf: this.leaf,
          id: streamId,
          idx: upToEventId,
          eventChannel: personalStream.eventChannel,
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

    this.runBackfill();
    console.log("Client connected");

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
      console.log("Leaf: connected");
    });
    this.leaf.on("disconnect", () => {
      console.log("Leaf: disconnected");
      this.#streamConnection = { status: "offline" };
    });
    this.leaf.on("authenticated", async (did) => {
      console.log("Leaf: authenticated as", did);
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

  async connectSpaceStream(streamId: StreamHashId, idx: StreamIndex) {
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to add new space stream");
    await this.#leafAuthenticated.promise;

    console.log("Connecting to space stream", streamId, idx);

    const alreadyConnected = this.#streamConnection.streams.get(streamId);
    if (alreadyConnected) {
      console.log("Already connected");
      return;
    }

    const stream = await ConnectedStream.connect({
      user: this.agent.assertDid as Did,
      leaf: this.leaf,
      id: streamId,
      idx,
      eventChannel: this.eventChannel,
    });

    await stream.backfill();
    this.#streamConnection.streams.set(streamId, stream);

    console.log("Successfully connected to stream");

    return;
  }

  async createSpaceStream() {
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to add new space stream");
    await this.#leafAuthenticated.promise;

    console.log("Creating space stream");
    const newStream = await ConnectedStream.createSpace({
      user: this.agent.assertDid as Did,
      leaf: this.leaf,
      eventChannel: this.eventChannel,
    });

    await newStream.backfill();

    console.log("Successfully created space stream:", newStream.id);

    // add to stream connection map
    this.#streamConnection.streams.set(newStream.id, newStream);

    return newStream.id as StreamHashId;
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
    eventChannel: AsyncChannel<Batch.Event>,
  ): Promise<ConnectedStream> {
    await this.#leafAuthenticated.promise;

    return await ConnectedStream.createPersonal({
      user: this.agent.assertDid as Did,
      leaf: this.leaf,
      eventChannel,
    });
  }

  async ensurePersonalStream(
    eventChannel: AsyncChannel<Batch.Event>,
  ): Promise<ConnectedStream> {
    if (this.personalStream) return this.personalStream;
    await this.#leafAuthenticated.promise;

    console.log("Looking for personal stream id");

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
        const existingRecord = getResponse.data.value as { id: StreamHashId };
        await personalStream.setIdCache(
          this.agent.assertDid,
          existingRecord.id,
        );
        console.log("Found existing stream ID from PDS:", existingRecord.id);
        stream = await ConnectedStream.connect({
          user: this.agent.assertDid as Did,
          leaf: this.leaf,
          id: existingRecord.id as StreamHashId,
          idx: 0 as StreamIndex,
          eventChannel,
        });
      } catch (e) {
        if ((e as any).error === "RecordNotFound") {
          console.log(
            "Could not find existing stream ID on PDS. Creating new stream!",
          );

          // create a new stream on leaf server
          stream = await this.createPersonalStream(eventChannel);

          console.log("Putting record");

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
          console.log("Stream does not exist");

          // delete record on PDS
          const deleteResponse = await this.agent.com.atproto.repo.deleteRecord(
            {
              collection: CONFIG.streamNsid,
              repo: this.agent.assertDid,
              rkey: CONFIG.streamSchemaVersion,
            },
          );
          if (!deleteResponse.success) {
            errors.push(
              new Error("Could not delete PDS record for personal stream", {
                cause: JSON.stringify(deleteResponse.data),
              }),
            );
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

    // Get the module id for this stream to check whether or not we need to update the module.
    const streamInfo = await this.leaf.streamInfo(stream.id);

    if (streamInfo.moduleId != personalModule.moduleId) {
      console.log(
        "Personal stream's module doesn't match our current personal module version",
      );
      const alreadyHasModule = await this.leaf.hasModule(
        personalModule.moduleId,
      );
      if (!alreadyHasModule) {
        console.log(
          "The leaf server doesn't have our module yet: uploading...",
        );
        await this.leaf.uploadModule(personalModule.encoded.buffer);
      }
      console.log("Updating module for personal stream to our current version");
      await this.leaf.updateModule(stream.id, personalModule.moduleId);
    }

    return stream;
  }

  async backfillStreamById(streamId: StreamHashId) {
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to backfill");

    const stream = this.#streamConnection.streams.get(streamId);
    if (!stream) throw new Error("Could not find stream " + streamId);

    return stream.backfill();
  }

  async runBackfill() {
    await this.#connected.promise;
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to run backfill");

    const streams = this.#streamConnection.streams;

    console.log("Running backfill for streams");

    const promises = [...streams.values()].map((stream) => {
      try {
        return this.backfillStreamById(stream.id);
      } catch (error) {
        console.error("Backfill error for", stream);
      }
    });

    await Promise.allSettled(promises);
    console.log("Backfill fetching done");
  }

  async sendEvent(streamId: string, event: EventType) {
    await this.#leafAuthenticated.promise;
    await this.leaf.sendEvent(streamId, {
      user: this.agent.assertDid,
      payload: eventCodec.enc(event),
    });
  }

  async sendEventBatch(streamId: string, payloads: EventType[]) {
    await this.#leafAuthenticated.promise;
    const encodedPayloads = payloads.map((x) => {
      try {
        return eventCodec.enc(x);
      } catch (e) {
        throw new Error(
          `Could not encode event: ${JSON.stringify(x, null, "  ")}`,
          { cause: e },
        );
      }
    });
    await this.leaf.sendEvents(
      streamId,
      encodedPayloads.map((payload) => ({
        user: this.agent.assertDid,
        payload,
      })),
    );
  }

  async fetchEvents(
    streamId: string,
    start: number,
    limit: number,
  ): Promise<EncodedStreamEvent[]> {
    await this.#leafAuthenticated.promise;
    const resp = await this.leaf?.query(streamId, {
      query_name: "events",
      limit: BigInt(limit),
      start: BigInt(start),
      params: [],
      requesting_user: this.agent.assertDid,
    });
    const events = parseEvents(resp);
    return events;
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
      $type: "space.roomy.upload",
      image: blobRef,
      alt: opts?.alt,
    };
    // Put the record in the repository
    await this.agent.com.atproto.repo.putRecord({
      repo: this.agent.assertDid,
      collection: "space.roomy.upload",
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
    spaceId: StreamHashId,
    handleAccountDid: Did,
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

  private resolveIdType(spaceIdOrHandleOrDid: StreamHashId | Handle | Did) {
    if (spaceIdOrHandleOrDid.includes(".")) {
      return "handle";
    } else if (isDid(spaceIdOrHandleOrDid)) {
      return "did";
    } else {
      return "streamId";
    }
  }

  private async resolveDidFromHandleOrDid(
    handleOrDid: Handle | Did,
  ): Promise<Did> {
    const type = this.resolveIdType(handleOrDid);
    switch (type) {
      case "handle":
        try {
          const profile = await this.getProfileCached(handleOrDid as Handle);
          return profile.data.did;
        } catch (e) {
          console.warn("Error resolving DID from handle", handleOrDid, e);
          throw e;
        }
      case "did":
        return handleOrDid as Did;
      default:
        throw new Error("Invalid type for DID resolution");
    }
  }

  async resolveSpaceId(
    spaceIdOrHandleOrDid: StreamHashId | Handle | Did,
  ): Promise<{
    spaceId: StreamHashId;
    handle?: Handle;
    did?: Did;
  }> {
    const type = this.resolveIdType(spaceIdOrHandleOrDid);

    if (type === "handle" || type === "did") {
      try {
        const did = await this.resolveDidFromHandleOrDid(
          spaceIdOrHandleOrDid as Handle | Did,
        );
        const spaceIdFromHandle = await this.getStreamHandleRecordCached(did);
        if (!spaceIdFromHandle) throw "Could not resolve space ID from handle";
        return {
          spaceId: spaceIdFromHandle!,
          handle:
            type === "handle" ? (spaceIdOrHandleOrDid as Handle) : undefined,
          did,
        };
      } catch (e) {
        console.warn(
          "Error resolving space from identifier",
          spaceIdOrHandleOrDid,
          e,
        );
        throw e;
      }
    } else {
      return { spaceId: spaceIdOrHandleOrDid as StreamHashId };
    }
  }

  /** Some streams have a handle configured as an alias via a PDS record that verifies the mapping.
   * This method fetches that record, with caching, and returns the associated stream ID and DID.
   */
  private async getStreamHandleRecordCached(
    did: Did,
  ): Promise<StreamHashId | undefined> {
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
        ? (resp.data.value.id as StreamHashId)
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
