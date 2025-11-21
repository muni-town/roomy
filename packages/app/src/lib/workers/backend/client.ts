import type { OAuthSession } from "@atproto/oauth-client";
import { createOauthClient } from "./oauth";
import { db, personalStream } from "../idb";
import { Agent, BlobRef, isDid } from "@atproto/api";
import { lexicons } from "$lib/lexicons";
import { LeafClient, type IncomingEvent } from "@muni-town/leaf-client";
import { CONFIG } from "$lib/config";
import { LEAF_MODULE_PERSONAL } from "../../moduleUrls";
import {
  type ConnectedStreams,
  type ConnectedStream,
  type EventType,
  type Profile,
  type LoadingPersonalStream,
  type StreamConnectionStatus,
  type StreamEvent,
  type StreamHashId,
  type EventBatch,
  type Ulid,
  type StreamIndex,
  type BackfillStatus,
} from "../types";
import { eventCodec, streamParamsCodec } from "../encoding";
import { ulid } from "ulidx";
import { Deferred } from "$lib/utils/deferred";
import { AsyncChannel } from "../asyncChannel";

interface LeafHandlers {
  connect: () => Promise<void>;
  disconnect: () => void;
  authenticated: (did: string) => Promise<void>;
  event: (event: IncomingEvent) => void;
}

export class Client {
  agent: Agent;
  leaf: LeafClient;
  #streamConnection: StreamConnectionStatus;
  #ready = new Deferred<LoadingPersonalStream>();
  #connected = new Deferred<ConnectedStreams>();

  constructor(agent: Agent, leaf: LeafClient) {
    this.agent = agent;
    this.leaf = leaf;
    this.#streamConnection = {
      status: "initialising",
    };
    this.setLeafHandlers();
  }

  get ready() {
    return this.#ready.promise;
  }

  get personalStreamFetched() {
    if (
      this.personalStream?.pin.type !== "space" ||
      this.personalStream.pin.backfill.status !== "priority"
    )
      throw new Error("Personal Stream should backfill entire stream");
    return this.personalStream.pin.backfill.completed;
  }

  loadPersonalStream(personalStreamId: StreamHashId) {
    console.log("setReadyToConnect");
    if (this.#streamConnection.status === "loadingPersonalStream")
      return this.#streamConnection.eventChannel;
    const eventChannel = new AsyncChannel<EventBatch>();
    this.#streamConnection = {
      status: "loadingPersonalStream",
      personalStream: {
        id: personalStreamId,
        pin: {
          type: "space",
          backfill: {
            status: "priority",
            upToEventId: 0,
            completed: new Deferred(),
          },
        },
      },
      eventChannel,
    };
    this.backfillPersonalStream();
    this.#ready.resolve(this.#streamConnection);
    return eventChannel;
  }

  get connected() {
    return this.#connected.promise;
  }

  async connect(streamList: Set<StreamHashId>) {
    if (!this.personalStream)
      throw new Error("Client must have personal stream to connect");

    console.log("Client connecting", streamList);
    const streams = new Map(
      [...streamList].map((stream) => {
        return [
          stream,
          {
            id: stream,
            pin: {
              type: "space", // we currently only support full backfill for everything
              backfill: {
                status: "background",
                upToEventId: 0,
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

      // Get the user's personal space ID
      console.log("Now looking for personal stream id");
      const personalStreamId = await this.ensurePersonalStream(did);
      this.leaf.subscribe(personalStreamId);
      console.log("Subscribed to stream:", personalStreamId);

      this.loadPersonalStream(personalStreamId);
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
        priority: "normal",
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

  async ensurePersonalStream(did: string) {
    if (this.personalStreamId) return this.personalStreamId;

    const id = await personalStream.getIdCache(did);
    if (id) {
      return id;
    }

    try {
      const resp1 = await this.agent.com.atproto.repo.getRecord({
        collection: CONFIG.streamNsid,
        repo: did,
        rkey: CONFIG.streamSchemaVersion,
      });
      const existingRecord = resp1.data.value as { id: StreamHashId };
      await personalStream.setIdCache(did, existingRecord.id);
      console.log("Found existing stream ID from PDS:", existingRecord.id);
      return existingRecord.id;
    } catch (_) {
      // this catch block creating a new stream needs to be refactored
      // so that it only happens when there definitely is no record
      console.log(
        "Could not find existing stream ID on PDS. Creating new stream!",
      );

      // create a new stream on leaf server
      const personalStreamId = await this.createPersonalStream();
      console.log("Created new stream:", personalStreamId);

      // put the stream ID in a record
      const resp2 = await this.agent.com.atproto.repo.putRecord({
        collection: CONFIG.streamNsid,
        record: { id: personalStreamId },
        repo: this.agent.assertDid,
        rkey: CONFIG.streamSchemaVersion,
      });
      if (!resp2.success) {
        throw new Error("Could not create PDS record for personal stream", {
          cause: JSON.stringify(resp2.data),
        });
      }
      // status.personalStreamId = personalStreamId;
      await personalStream.setIdCache(did, personalStreamId);
      return personalStreamId;
    }
  }

  async upToEventId(streamId: StreamHashId) {
    const entry = await db.streamCursors.get(streamId);
    if (entry) return entry.latestEvent;
    return 0;
  }

  async backfillPersonalStream() {
    // start fetching all the events
    if (!this.personalStreamId)
      throw new Error("No personal stream to backfill");
    let fetchCursor = await this.upToEventId(this.personalStreamId);
    console.log("Personal stream backfilled to", fetchCursor);

    while (true) {
      console.time("fetchBatch");

      const batchSize = 2500;
      const newEvents = (
        await this.fetchEvents(
          this.personalStreamId,
          fetchCursor + 1,
          batchSize,
        )
      ).map((ev) => {
        return {
          idx: ev.idx as StreamIndex,
          user: ev.user,
          payload: ev.payload,
        };
      });

      if (newEvents.length == 0) {
        if (
          this.personalStream?.pin.type !== "space" ||
          this.personalStream.pin.backfill.status !== "priority"
        )
          throw new Error("Personal Stream should backfill entire stream");

        // mark backfill state suspended
        this.personalStreamFetched.resolve();
        this.personalStream.pin.backfill = {
          status: "suspended",
          upToEventId: fetchCursor,
        };
        break;
      }
      this.eventChannel.push({
        status: "fetched",
        batchId: ulid() as Ulid,
        streamId: this.personalStreamId,
        events: newEvents,
        priority: "normal",
      });

      // IDB Stream Cursor is updated in the SQLite worker when materialisation done

      fetchCursor += batchSize;
      console.timeEnd("fetchBatch");
    }
  }

  async backfillStream(streamId: StreamHashId) {
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to backfill");
    const backfillStatus = this.#streamConnection.streams.get(streamId);
    if (!backfillStatus) throw new Error("Could not find stream " + streamId);
    // start fetching all the events
    let fetchCursor = await this.upToEventId(streamId);
    console.log(`stream ${streamId} backfilled to ${fetchCursor}`);

    while (true) {
      console.time("fetchBatch-" + streamId);

      if (
        backfillStatus.pin.type !== "space" ||
        backfillStatus.pin.backfill.status !== "background"
      )
        throw new Error(
          "Pin type & backfill status status expected to be 'space' and 'background'",
        );

      const batchSize = 2500;
      const newEvents = (
        await this.fetchEvents(streamId, fetchCursor + 1, batchSize)
      ).map((ev) => {
        return {
          idx: ev.idx as StreamIndex,
          user: ev.user,
          payload: ev.payload,
        };
      });

      if (newEvents.length == 0) {
        // mark backfill state suspended
        this.personalStreamFetched.resolve();
        backfillStatus.pin.backfill = {
          status: "suspended",
          upToEventId: fetchCursor,
        };
        break;
      }
      this.eventChannel.push({
        status: "fetched",
        batchId: ulid() as Ulid,
        streamId,
        events: newEvents,
        priority: backfillStatus.pin.backfill.status,
      });

      // IDB Stream Cursor is updated in the SQLite worker when materialisation done

      fetchCursor += batchSize;
      console.timeEnd("fetchBatch-" + streamId);
    }
  }

  async runBackfill() {
    await this.#connected.promise;
    if (this.#streamConnection.status !== "connected")
      throw new Error("Client must be connected to run backfill");

    const streams = this.#streamConnection.streams;

    console.log("Running backfill for streams", streams);

    const promises = [...streams.values()].map((stream) => {
      try {
        return this.backfillStream(stream.id);
      } catch (error) {
        console.error("Backfill error for", stream);
      }
    });

    await Promise.allSettled(promises);
    console.log("Backfill fetching done");
  }

  async sendEvent(streamId: string, event: EventType) {
    await this.leaf.sendEvent(
      streamId,
      eventCodec.enc(event).buffer as ArrayBuffer,
    );
  }

  async sendEventBatch(streamId: string, payloads: EventType[]) {
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

  async resolveHandleForSpace(
    spaceId: string,
    handleAccountDid: string,
  ): Promise<string | undefined> {
    try {
      const resp = await this.agent.getProfile({
        actor: handleAccountDid,
      });
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
      return result;
    } catch (e) {
      console.warn("Error resolving space from handle", e);
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

  static async fromSession(session: OAuthSession) {
    try {
      await db.kv.put({ key: "did", value: session.did });

      const agent = new Agent(session);

      lexicons.forEach((l) => agent.lex.add(l as any));

      const leaf = new LeafClient(CONFIG.leafUrl, async () => {
        const resp = await agent?.com.atproto.server.getServiceAuth({
          aud: `did:web:${new URL(CONFIG.leafUrl).host}`,
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

  static async new() {
    const client = await createOauthClient();

    // if there's a stored DID and no session yet, try to restore the session
    const didEntry = await db.kv.get("did");
    if (!didEntry) throw new Error("Failed to retrieve DID from IndexedDB");

    const restoredSession = await client.restore(didEntry.value);
    return Client.fromSession(restoredSession);
  }

  static async oauthCallback(params: URLSearchParams) {
    const oauth = await createOauthClient();
    const response = await oauth.callback(params);
    return Client.fromSession(response.session);
  }

  static async login(handle: string) {
    const oauth = await createOauthClient();
    const url = await oauth.authorize(handle, {
      scope: CONFIG.atprotoOauthScope,
    });
    return url.href;
  }
}
