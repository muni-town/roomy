import type { OAuthSession } from "@atproto/oauth-client";
import { createOauthClient } from "./oauth";
import { db, personalStream } from "../idb";
import { Agent, BlobRef, isDid, type Did } from "@atproto/api";
import { lexicons } from "$lib/lexicons";
import { LeafClient, type IncomingEvent } from "@muni-town/leaf-client";
import { CONFIG } from "$lib/config";
import { LEAF_MODULE_PERSONAL } from "../../moduleUrls";
import {
  type EventType,
  type StreamHashId,
  type Ulid,
  type StreamIndex,
  type TaskPriority,
  type Batch,
} from "../types";
import { type Profile } from "$lib/types/profile";
import { eventCodec, streamParamsCodec } from "../encoding";
import { ulid } from "ulidx";
import { Deferred } from "$lib/utils/deferred";
import { AsyncChannel } from "../asyncChannel";
import type {
  StreamConnectionStatus,
  ConnectionStates,
  ConnectedStream,
} from "./types";

export class Client {
  agent: Agent;
  leaf: LeafClient;
  #streamConnection: StreamConnectionStatus;
  #leafAuthenticated = new Deferred();
  #personalStreamIdReady =
    new Deferred<ConnectionStates.LoadingPersonalStream>();
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
    this.ensurePersonalStream();
  }

  // get a URL for redirecting to the ATProto PDS for login
  static async login(handle: string) {
    const oauth = await createOauthClient();
    const url = await oauth.authorize(handle, {
      scope: CONFIG.atprotoOauthScope,
    });
    return url.href;
  }

  // restore previous session
  static async new() {
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

  static async fromSession(session: OAuthSession) {
    try {
      await db.kv.put({ key: "did", value: session.did });

      const agent = new Agent(session);

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
      // db.kv.delete("did");
      throw new Error("Failed to create client");
    }
  }

  get ready() {
    return this.#personalStreamIdReady.promise;
  }

  get status() {
    return this.#streamConnection.status;
  }

  get personalStreamFetched() {
    if (
      this.personalStream?.pin.type !== "space" ||
      this.personalStream.pin.backfill.status !== "priority"
    )
      throw new Error("Personal Stream should backfill entire stream");
    return this.personalStream.pin.backfill.completed;
  }

  loadPersonalStream(personalStreamId: StreamHashId, upToEventId: StreamIndex) {
    console.log("setReadyToConnect");

    if (this.#streamConnection.status === "loadingPersonalStream")
      return this.#streamConnection.eventChannel;

    const eventChannel = new AsyncChannel<Batch.Event>();
    this.#streamConnection = {
      status: "loadingPersonalStream",
      personalStream: {
        id: personalStreamId,
        pin: {
          type: "space",
          backfill: {
            status: "priority",
            upToEventId,
            completed: new Deferred(),
          },
        },
      },
      eventChannel,
    };
    this.backfillPersonalStream();
    this.#personalStreamIdReady.resolve(this.#streamConnection);
    return eventChannel;
  }

  get connected() {
    return this.#connected.promise;
  }

  async connect(streamList: Map<StreamHashId, StreamIndex>) {
    if (!this.personalStream)
      throw new Error("Client must have personal stream to connect");

    console.log("Client connecting", streamList);
    const streams = new Map(
      [...streamList.entries()].map(([stream, upToEventId]) => {
        this.leaf.subscribe(stream);
        return [
          stream,
          {
            id: stream,
            pin: {
              type: "space", // we currently only support full backfill for everything
              backfill: {
                status: "background",
                upToEventId,
                completed: new Deferred(),
              },
            } as const,
          },
        ];
      }),
    );

    this.setConnected(streams);
    this.runBackfill();
    console.log("Client connected", this);

    return streams;
  }

  setConnected(streams: Map<StreamHashId, ConnectedStream>) {
    if (
      this.#streamConnection.status !== "loadingPersonalStream" ||
      !this.personalStreamId
    )
      throw new Error("Client not ready to connect");
    this.#streamConnection = {
      status: "connected",
      personalStream: this.#streamConnection.personalStream,
      eventChannel: this.#streamConnection.eventChannel,
      streams,
    };
    this.#connected.resolve(this.#streamConnection);
  }

  get eventChannel() {
    if (
      this.#streamConnection.status !== "connected" &&
      this.#streamConnection.status !== "loadingPersonalStream"
    )
      throw new Error(
        "Client is not connected. Status: " + this.#streamConnection.status,
      );
    return this.#streamConnection.eventChannel;
  }

  async getEventChannel() {
    await this.ready;
    return this.eventChannel;
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

      const state = await this.#personalStreamIdReady.promise;

      this.leaf.subscribe(state.personalStream.id);
      console.log("Subscribed to stream:", state.personalStream.id);
    });
    this.leaf.on("event", (event) => {
      this.eventChannel.push({
        status: "pushed",
        batchId: ulid() as Ulid,
        streamId: event.stream as StreamHashId,
        events: [
          {
            idx: event.idx as StreamIndex,
            user: event.user,
            payload: event.payload,
          },
        ],
        priority: "priority",
      });
    });
  }

  async getProfile(did?: string): Promise<Profile | undefined> {
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

  async createStream(
    ulid: string,
    moduleId: string,
    moduleUrl: string,
    params?: ArrayBuffer,
  ): Promise<string> {
    await this.#leafAuthenticated.promise;
    return await this.leaf.createStreamFromModuleUrl(
      ulid,
      moduleId,
      moduleUrl,
      params || new ArrayBuffer(),
    );
  }

  get personalStream() {
    if (this.#streamConnection.status === "loadingPersonalStream")
      return this.#streamConnection.personalStream;
    else if (this.#streamConnection.status === "connected")
      return this.#streamConnection.personalStream;
    else return undefined;
  }

  get personalStreamId() {
    if (this.#streamConnection.status === "loadingPersonalStream")
      return this.#streamConnection.personalStream.id;
    else if (this.#streamConnection.status === "connected")
      return this.#streamConnection.personalStream.id;
    else return undefined;
  }

  async createPersonalStream() {
    const personalStreamUlid = ulid();
    await this.#leafAuthenticated.promise;
    return (await this.leaf.createStreamFromModuleUrl(
      personalStreamUlid,
      LEAF_MODULE_PERSONAL.id,
      LEAF_MODULE_PERSONAL.url,
      streamParamsCodec.enc({
        streamType: "space.roomy.stream.personal",
        schemaVersion: CONFIG.streamSchemaVersion,
      }).buffer as ArrayBuffer,
    )) as StreamHashId;
  }

  async ensurePersonalStream() {
    if (this.personalStreamId) return this.personalStreamId;

    console.log("Now looking for personal stream id");

    let id = await personalStream.getIdCache(this.agent.assertDid);
    if (!id) {
      try {
        const resp1 = await this.agent.com.atproto.repo.getRecord({
          collection: CONFIG.streamNsid,
          repo: this.agent.assertDid,
          rkey: CONFIG.streamSchemaVersion,
        });
        const existingRecord = resp1.data.value as { id: StreamHashId };
        await personalStream.setIdCache(
          this.agent.assertDid,
          existingRecord.id,
        );
        console.log("Found existing stream ID from PDS:", existingRecord.id);
        id = existingRecord.id;
      } catch (_) {
        // this catch block creating a new stream needs to be refactored
        // so that it only happens when there definitely is no record
        console.log(
          "Could not find existing stream ID on PDS. Creating new stream!",
        );

        // create a new stream on leaf server
        id = await this.createPersonalStream();
        console.log("Created new stream:", id);

        // put the stream ID in a record
        const resp2 = await this.agent.com.atproto.repo.putRecord({
          collection: CONFIG.streamNsid,
          record: { id },
          repo: this.agent.assertDid,
          rkey: CONFIG.streamSchemaVersion,
        });
        if (!resp2.success) {
          throw new Error("Could not create PDS record for personal stream", {
            cause: JSON.stringify(resp2.data),
          });
        }
        // status.personalStreamId = personalStreamId;
        await personalStream.setIdCache(this.agent.assertDid, id);
      }
    }
    return id;
  }

  async backfillPersonalStream() {
    // start fetching all the events
    if (!this.personalStreamId || !this.personalStream)
      throw new Error("No personal stream to backfill");

    return this.backfillStream(this.personalStream, "priority");
  }

  async backfillStreamById(
    streamId: StreamHashId,
    priority: TaskPriority = "background",
  ) {
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to backfill");
    const stream = this.#streamConnection.streams.get(streamId);
    if (!stream) throw new Error("Could not find stream " + streamId);

    return this.backfillStream(stream, priority);
  }

  private async backfillStream(
    stream: ConnectedStream,
    priority: TaskPriority,
  ) {
    if (stream.pin.type !== "space" || stream.pin.backfill.status !== priority)
      throw new Error(
        "Pin type & backfill status status expected to be 'space' and " +
          priority,
      );

    let fetchCursor = stream.pin.backfill.upToEventId;

    console.log(`stream ${stream.id} backfilled to ${fetchCursor}`);

    while (true) {
      console.time("fetchBatch-" + stream.id);

      const batchSize = 2500;
      const newEvents = (
        await this.fetchEvents(stream.id, fetchCursor + 1, batchSize)
      ).map((ev) => {
        return {
          idx: ev.idx as StreamIndex,
          user: ev.user,
          payload: ev.payload,
        };
      });

      if (newEvents.length == 0) {
        // mark backfill state idle
        stream.pin.backfill.completed.resolve();
        stream.pin.backfill = {
          status: "idle",
          upToEventId: fetchCursor,
        };
        break;
      }
      this.eventChannel.push({
        status: "fetched",
        batchId: ulid() as Ulid,
        streamId: stream.id,
        events: newEvents,
        priority: stream.pin.backfill.status,
      });

      // comp_space.backfilled_to cursor is updated in SQLite after each batch is applied

      fetchCursor += batchSize;
      console.timeEnd("fetchBatch-" + stream.id);

      // slow down backfill for debugging
      // await new Promise(() => {});
    }

    console.log("Finished backfill for stream", stream.id);
  }

  async runBackfill() {
    await this.#connected.promise;
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to run backfill");

    const streams = this.#streamConnection.streams;

    console.log("Running backfill for streams", streams);

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
    await this.leaf.sendEvent(
      streamId,
      eventCodec.enc(event).buffer as ArrayBuffer,
    );
  }

  async sendEventBatch(streamId: string, payloads: EventType[]) {
    await this.#leafAuthenticated.promise;
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
    await this.leaf.sendEvents(streamId, encodedPayloads);
  }

  async fetchEvents(
    streamId: string,
    offset: number,
    limit: number,
  ): Promise<IncomingEvent[]> {
    await this.#leafAuthenticated.promise;
    const events = (
      await this.leaf?.fetchEvents(streamId, { offset, limit })
    )?.map((x) => ({
      ...x,
      stream: streamId,
    }));
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

  async getProfileCached(actor: string) {
    const cached = this.#agentProfileCache.get(actor);
    if (cached) return cached.result;

    const resp = await this.agent.getProfile({
      actor,
    });
    this.#agentProfileCache.set(actor, { result: resp });

    return resp;
  }

  async resolveHandleForSpace(
    spaceId: string,
    handleAccountDid: string,
  ): Promise<string | undefined> {
    try {
      const resp = await this.getProfileCached(handleAccountDid);
      const handle = resp.data.handle;
      const did = handleAccountDid;
      const resolvedSpaceId = (await this.resolveSpaceFromHandleOrDid(did))
        ?.spaceId;
      if (resolvedSpaceId == spaceId) {
        return handle;
      }
    } catch (e) {
      console.warn("error while resolving handle for space", e);
      return undefined;
    }
  }

  async resolveSpaceFromHandleOrDid(handleOrDid: string) {
    try {
      const did = isDid(handleOrDid)
        ? handleOrDid
        : (
            await this.agent.getProfile({
              actor: handleOrDid,
            })
          ).data.did;

      const result = this.getStreamHandleRecordCached(did as Did);
      return result;
    } catch (e) {
      console.warn("Error resolving space from handle", e);
      return undefined;
    }
  }

  private async getStreamHandleRecordCached(did: Did) {
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

      const result = resp.data.value?.id
        ? {
            spaceId: resp.data.value.id as string,
            handleDid: did,
          }
        : undefined;

      this.#agentStreamHandleCache.set(did, { result });
      return result;
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
