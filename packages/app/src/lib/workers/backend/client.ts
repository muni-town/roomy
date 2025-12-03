import type { OAuthSession } from "@atproto/oauth-client";
import { createOauthClient } from "./oauth";
import { db, personalStream } from "../idb";
import { Agent, BlobRef, isDid, type Did } from "@atproto/api";
import { lexicons } from "$lib/lexicons";
import { LeafClient, type SqlRows } from "@muni-town/leaf-client";
import { CONFIG } from "$lib/config";
import {
  type EventType,
  type StreamHashId,
  type Ulid,
  type StreamIndex,
  type TaskPriority,
  type Batch,
  type EncodedStreamEvent,
} from "../types";
import { type Profile } from "$lib/types/profile";
import { eventCodec } from "../encoding";
import { ulid } from "ulidx";
import { Deferred } from "$lib/utils/deferred";
import { AsyncChannel } from "../asyncChannel";
import type {
  StreamConnectionStatus,
  ConnectionStates,
  ConnectedStream,
} from "./types";

const personalModule = LeafClient.encodeBasicModule({
  init_sql: `
    create table if not exists stream_info as select
      (select creator from stream) as creator, 
      'space.roomy.stream.personal' as type,
      '2' as schema_version;
  `,
  authorizer: `
    select unauthorized("Only stream owner can add events")
      where (select creator from stream_info) != (select user from event);
  `,
  materializer: ``,
  queries: [
    {
      name: "stream_info",
      sql: `select * from stream_info;`,
      limits: [],
      params: [],
    },
    {
      name: "events",
      sql: `
        select unauthorized('only the strema creator can read its events')
          where $requesting_user != (select creator from stream_info);

        select id, user, payload from events.events
          where id >= $start limit $limit;
      `,
      limits: [],
      params: [],
    },
  ],
});
console.info("Personal module ID:", personalModule.moduleId);

const spaceModule = LeafClient.encodeBasicModule({
  init_sql: `
    create table if not exists stream_info as select
      (select creator from stream) as creator, 
      'space.roomy.stream.space' as type,
      '2' as schema_version;
  `,
  authorizer: ``,
  materializer: ``,
  queries: [
    {
      name: "stream_info",
      sql: `select * from stream_info;`,
      limits: [],
      params: [],
    },
    {
      name: "events",
      sql: `
        select id, user, payload from events.events
          where id >= $start limit $limit;
      `,
      limits: [],
      params: [],
    },
  ],
});
console.info("Space module ID:", spaceModule.moduleId);

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
  #streamUnsubscribers = new Map<string, () => Promise<void>>();

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

      console.log("Initialized leaf client");
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

      await this.leaf.subscribe(
        state.personalStream.id,
        {
          query_name: "events",
          requesting_user: this.agent.assertDid,
          params: [],
          start:
            state.personalStream.pin.type == "space"
              ? BigInt((state.personalStream.pin.backfill.upToEventId || 0) + 1)
              : 1n,
          limit: 1n,
        },
        (result) => {
          if (result.success) {
            const events = parseEvents(result.value);
            for (const event of events) {
              this.eventChannel.push({
                status: "pushed",
                batchId: ulid() as Ulid,
                streamId: state.personalStream.id as StreamHashId,
                events: [
                  {
                    idx: event.idx as StreamIndex,
                    user: event.user,
                    payload: event.payload,
                  },
                ],
                priority: "priority",
              });
            }
          }
        },
      );
      console.log("Subscribed to stream:", state.personalStream.id);
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

  async createSpaceStream(): Promise<string> {
    await this.#leafAuthenticated.promise;
    const moduleId = await this.leaf.uploadModule(spaceModule.encoded.buffer);

    const streamId = await this.leaf.createStream({
      stamp: ulid(),
      creator: this.agent.assertDid,
      module: moduleId,
      options: [],
    });
    return streamId as StreamHashId;
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
    await this.#leafAuthenticated.promise;
    const moduleId = await this.leaf.uploadModule(
      personalModule.encoded.buffer,
    );
    console.log("uploaded personal module:", moduleId);

    const streamId = await this.leaf.createStream({
      stamp: ulid(),
      creator: this.agent.assertDid,
      module: moduleId,
      options: [],
    });
    console.log("created personal stream:", streamId);
    return streamId as StreamHashId;
  }

  async ensurePersonalStream() {
    if (this.personalStreamId) return this.personalStreamId;

    console.log("Now looking for personal stream id");

    // TODO: Caching the personal stream ID causes problems when it gets cached and the PDS record
    // has changed because the app will just get stuck loading forever trying to get the stream that
    // doesn't exist. For now we just disable loading the stream ID from cache. I don't think it's
    // unreasonable to just fetch this on startup for now.

    // let id = await personalStream.getIdCache(this.agent.assertDid);
    let id;
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
      } catch (e) {
        if ((e as any).error === "RecordNotFound") {
          console.log(
            "Could not find existing stream ID on PDS. Creating new stream!",
          );

          // create a new stream on leaf server
          id = await this.createPersonalStream();

          console.log("Putting record");

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
        } else {
          console.error("Error while fetching personal stream record:", e);
        }
      }
    }

    // Get the module id for this stream to check whether or not we need to update the module.
    const streamInfo = await this.leaf.streamInfo(id);
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
      await this.leaf.updateModule(id, personalModule.moduleId);
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

    // Unsubscribe from the stream during backfill if we have a subscription already
    this.#streamUnsubscribers.get(stream.id)?.();
    this.#streamUnsubscribers.delete(stream.id);

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

      fetchCursor += newEvents.length;
      console.timeEnd("fetchBatch-" + stream.id);

      // slow down backfill for debugging
      // await new Promise(() => {});
    }

    this.#streamUnsubscribers.set(
      stream.id,
      await this.leaf.subscribe(
        stream.id,
        {
          query_name: "events",
          requesting_user: this.agent.assertDid,
          params: [],
          start: BigInt(fetchCursor + 1),
          limit: 1n,
        },
        (result) => {
          if (result.success) {
            const events = parseEvents(result.value);
            for (const event of events) {
              this.eventChannel.push({
                status: "pushed",
                batchId: ulid() as Ulid,
                streamId: stream.id as StreamHashId,
                events: [
                  {
                    idx: event.idx as StreamIndex,
                    user: event.user,
                    payload: event.payload,
                  },
                ],
                priority: "priority",
              });
            }
          }
        },
      ),
    );

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

function parseEvents(rows: SqlRows): EncodedStreamEvent[] {
  const columnNamesAreValid =
    rows.column_names[0] == "id" &&
    rows.column_names[1] == "user" &&
    rows.column_names[2] == "payload";
  if (!columnNamesAreValid)
    throw new Error("Invalid column names for events response");

  return rows.rows.map((x) => {
    if (
      x.values[0]?.tag != "integer" ||
      x.values[1]?.tag != "text" ||
      x.values[2]?.tag != "blob"
    )
      throw new Error(
        `Invalid column type for events response: ${JSON.stringify(x, (_key, value) => (typeof value == "bigint" ? value.toString() : value))}`,
      );

    return {
      idx: Number(x.values[0].value) as StreamIndex,
      user: x.values[1].value,
      payload: x.values[2].value.buffer,
    };
  });
}
