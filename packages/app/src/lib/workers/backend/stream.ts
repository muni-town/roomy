import type { LeafClient, LeafQuery, SqlRows } from "@muni-town/leaf-client";
import type { Batch, EncodedStreamEvent, TaskPriority } from "../types";
import type { AsyncChannel } from "../asyncChannel";
import {
  StreamDid,
  newUlid,
  StreamIndex,
  type,
  UserDid,
  type Event,
  Ulid,
} from "$lib/schema";
import { encode } from "@atcute/cbor";
import { Deferred } from "$lib/utils/deferred";
import type { ModuleWithCid } from "./modules";

interface ConnectedStreamOpts {
  user: UserDid;
  leaf: LeafClient;
  id: StreamDid;
  idx: StreamIndex;
  eventChannel: AsyncChannel<Batch.Events>;
  module: ModuleWithCid;
  priority?: TaskPriority;
}

export class ConnectedStream {
  user: UserDid;
  leaf: LeafClient;
  id: StreamDid;
  /** oldest 'end' in query for each room */
  lazyEndIdx: Map<Ulid, StreamIndex> = new Map();
  backfillStatus:
    | { status: "pending" }
    | { status: "started" }
    | { status: "finished" }
    | { status: "errored"; error: string } = { status: "pending" };
  eventChannel: AsyncChannel<Batch.Events>;
  unsubscribeEventsFn: (() => Promise<void>) | null = null;
  #doneBackfillingEvents = new Deferred();
  unsubscribeMetadataFn: (() => Promise<void>) | null = null;
  // returns the latest event
  #doneBackfillingMetadata = new Deferred<StreamIndex>();

  private constructor(opts: {
    user: UserDid;
    leaf: LeafClient;
    id: StreamDid;
    eventChannel: AsyncChannel<Batch.Events>;
  }) {
    this.user = opts.user;
    this.leaf = opts.leaf;
    this.id = opts.id;
    this.eventChannel = opts.eventChannel;
  }

  /** Sync factory for where stream existence doesn't need checking */
  static assert(opts: ConnectedStreamOpts) {
    return new ConnectedStream({
      user: opts.user,
      leaf: opts.leaf,
      id: opts.id,
      eventChannel: opts.eventChannel,
    });
  }

  /** Async factory that checks for stream existence */
  static async connect(opts: ConnectedStreamOpts) {
    try {
      const { moduleCid } = await opts.leaf.streamInfo(opts.id);
      if (moduleCid != (await opts.module.cid)) {
        console.info(
          `Module for stream ${opts.id} ( ${moduleCid} ) is different than desired module ( ${await opts.module.cid} ) updating...`,
        );

        if (!(await opts.leaf.hasModule(await opts.module.cid))) {
          console.log(
            "The leaf server doesn't have module, uploading:",
            await opts.module.cid,
          );
          await opts.leaf.uploadModule(opts.module.def);
        }
        try {
          await opts.leaf.updateModule(opts.id, await opts.module.cid);
        } catch (e) {
          // This may fail if the user is not an admin, which is fine
          console.warn(
            "Could not update space module to latest version. \
            This can be normal if the user is not an admin:",
            e,
          );
        }
      }
      return ConnectedStream.assert(opts);
    } catch (e) {
      console.error("stream info error:", e);
      throw new Error(
        "Stream does not exist (on this Leaf server). Stream ID: " + opts.id,
      );
    }
  }

  static async create(opts: Omit<ConnectedStreamOpts, "id" | "idx">) {
    try {
      console.log("Creating stream", opts);

      if (!(await opts.leaf.hasModule(await opts.module.cid))) {
        console.info(
          "Leaf server does not have module yet. Uploading:",
          await opts.module.cid,
        );
        await opts.leaf.uploadModule(opts.module.def);
      }

      const { streamDid } = await opts.leaf.createStream(await opts.module.cid);

      console.log("created stream:", streamDid);

      // Now send an addAdmin event
      await opts.leaf.sendEvent(
        streamDid,
        encode({
          id: newUlid(),
          room: undefined,
          variant: {
            $type: "space.roomy.space.addAdmin.v0",
            userId: opts.user,
          },
        } satisfies Event),
      );

      return await ConnectedStream.connect({
        ...opts,
        id: StreamDid.assert(streamDid),
        idx: 0 as StreamIndex,
      });
    } catch (e) {
      console.error("Error creating space stream", e);
      throw e;
    }
  }

  async subscribeEvents(start: number = 0) {
    this.unsubscribeEventsFn = await this.leaf.subscribeEvents(
      this.id,
      {
        name: "events",
        params: {},
        start,
        limit: 2500,
      },
      async (result) => {
        if ("Ok" in result) {
          if (!result.Ok.has_more) {
            this.backfillStatus = { status: "finished" };
            this.#doneBackfillingEvents.resolve();
          }

          const events = parseEvents(result.Ok.rows);
          this.eventChannel.push({
            status: "events",
            batchId: newUlid(),
            streamId: this.id as StreamDid,
            events,
            priority: "priority",
          });
        } else {
          console.error("Subscribed query error:", result.Err);
          this.backfillStatus = { status: "errored", error: result.Err };
        }
      },
    );
    this.backfillStatus = { status: "started" };
    return this.#doneBackfillingEvents.promise;
  }

  async subscribeMetadata(start: number = 0) {
    let latest = 0 as StreamIndex;
    this.unsubscribeMetadataFn = await this.leaf.subscribeEvents(
      this.id,
      {
        name: "metadata",
        params: {},
        start,
        limit: 2500,
      },
      async (result) => {
        if ("Ok" in result) {
          const events = parseEvents(result.Ok.rows);
          this.eventChannel.push({
            status: "events",
            batchId: newUlid(),
            streamId: this.id as StreamDid,
            events,
            priority: "priority",
          });

          const latestEvent = events.sort((a, b) => (a.idx < b.idx ? 1 : -1))[0]
            ?.idx;
          latest = latestEvent || latest;

          if (!result.Ok.has_more) {
            this.backfillStatus = { status: "finished" };
            console.log("Done backfilling metadata", latest);
            this.#doneBackfillingMetadata.resolve(latest);
          }
        } else {
          console.error("Subscribed query error:", result.Err);
          this.backfillStatus = { status: "errored", error: result.Err };
        }
      },
    );
    this.backfillStatus = { status: "started" };
    return this.#doneBackfillingMetadata.promise;
  }

  async unsubscribeEvents() {
    if (!this.unsubscribeEventsFn) throw new Error("Not subscribed to events");
    await this.unsubscribeEventsFn();
  }

  async unsubscribeMetadata() {
    if (!this.unsubscribeMetadataFn)
      throw new Error("Not subscribed to metadata");
    await this.unsubscribeMetadataFn();
  }

  async fetchRoom(
    roomId: Ulid,
    limit: number,
    end?: StreamIndex,
  ): Promise<EncodedStreamEvent[]> {
    const params: LeafQuery["params"] = {
      room: { $type: "muni.town.sqliteValue.text", value: roomId },
    };
    if (end)
      params["end"] = { $type: "muni.town.sqliteValue.integer", value: end };
    const resp = await this.leaf?.query(this.id, {
      name: "room",
      params,
      limit,
    });
    const events = parseEvents(resp);
    return events;
  }

  /** Fetch and apply events in a room in order of recency
   * @param roomId room to fetch for
   * @param limit number of events to fetch
   * @param end fetch in descending order starting at this (most recent) index.
   *        Defaults to fetching most recent
   */
  async lazyLoadRoom(roomId: Ulid, limit: number, end?: StreamIndex) {
    // no op if has end is more recent than the lazy cursor
    const lazyEndIdx = this.lazyEndIdx.get(roomId);
    const alreadyFetched =
      (!end && lazyEndIdx) || (end && lazyEndIdx && end >= lazyEndIdx);

    if (alreadyFetched) return;

    const oldestEnd = end || lazyEndIdx;
    if (oldestEnd) this.lazyEndIdx.set(roomId, oldestEnd);

    const events = await this.fetchRoom(roomId, limit, end);
    // materialise
    this.eventChannel.push({
      status: "events",
      batchId: newUlid(),
      streamId: this.id as StreamDid,
      events,
      priority: "priority",
    });

    if (end) return;
    // for the initial case for room load, set cursor to the most recent idx from the returned events
    const actualEnd = events.sort((a, b) => (a.idx < b.idx ? 1 : -1))[0]?.idx;
    if (actualEnd) this.lazyEndIdx.set(roomId, actualEnd);
  }

  get doneBackfilling(): Promise<void> {
    return this.#doneBackfillingEvents.promise;
  }

  async unsubscribe() {
    if (this.unsubscribeEventsFn) {
      await this.unsubscribeEventsFn();
      this.unsubscribeEventsFn = null;
    }
  }

  async fetchEvents(
    start: StreamIndex,
    limit: number,
  ): Promise<EncodedStreamEvent[]> {
    const resp = await this.leaf?.query(this.id, {
      name: "events",
      params: {},
      limit,
      start,
    });
    const events = parseEvents(resp);
    return events;
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
