import type { LeafClient, SqlRows } from "@muni-town/leaf-client";
import type { Batch, EncodedStreamEvent, TaskPriority } from "../types";
import type { AsyncChannel } from "../asyncChannel";
import { personalModule, spaceModule } from "./modules";
import {
  StreamDid,
  newUlid,
  StreamIndex,
  type,
  type UserDid,
  type Event,
} from "$lib/schema";
import { encode } from "@atcute/cbor";
import { Deferred } from "$lib/utils/deferred";

interface ConnectedStreamOpts {
  user: UserDid;
  leaf: LeafClient;
  id: StreamDid;
  idx: StreamIndex;
  eventChannel: AsyncChannel<Batch.Events>;
  priority?: TaskPriority;
}

export class ConnectedStream {
  user: UserDid;
  leaf: LeafClient;
  id: StreamDid;
  #doneBackfilling = new Deferred();
  backfillStatus:
    | { status: "pending" }
    | { status: "started" }
    | { status: "finished" }
    | { status: "errored"; error: string } = { status: "pending" };
  eventChannel: AsyncChannel<Batch.Events>;
  unsubscribeFn: (() => Promise<void>) | null = null;

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
      await opts.leaf.streamInfo(opts.id);
      return ConnectedStream.assert(opts);
    } catch (e) {
      console.error("stream info error:", e);
      throw new Error(
        "Stream does not exist (on this Leaf server). Stream ID: " + opts.id,
      );
    }
  }

  static async createSpace(opts: Omit<ConnectedStreamOpts, "id" | "idx">) {
    try {
      console.log("Creating space stream", opts);
      const spaceModuleResp = await opts.leaf.uploadModule(spaceModule);

      const { streamDid } = await opts.leaf.createStream(
        spaceModuleResp.moduleCid,
      );

      console.log("created space stream:", streamDid);

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

  static async createPersonal(
    opts: Omit<ConnectedStreamOpts, "id" | "idx" | "priority">,
  ) {
    try {
      console.log("Creating personal stream", opts);
      const personalModuleResp = await opts.leaf.uploadModule(personalModule);

      const { streamDid } = await opts.leaf.createStream(
        personalModuleResp.moduleCid,
      );

      console.log("created personal stream:", streamDid);

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

      return ConnectedStream.assert({
        ...opts,
        id: StreamDid.assert(streamDid),
        idx: 0 as StreamIndex,
        priority: "priority",
      });
    } catch (e) {
      console.error("Error creating personal stream", e);
      throw e;
    }
  }

  async subscribe(start: number = 0) {
    this.unsubscribeFn = await this.leaf.subscribe(
      this.id,
      {
        name: "events",
        params: {},
        start,
        limit: 2500,
      },
      async (result) => {
        if ("Ok" in result) {
          // TODO: WE don't really know at this point that backfiling is done, so we need to refine
          // this later with a way to get from the server that we have finished.
          this.backfillStatus = { status: "finished" };
          this.#doneBackfilling.resolve();

          const events = parseEvents(result.Ok);
          this.eventChannel.push({
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
  }

  async subscribeMetadata(start: number = 0) {
    this.unsubscribeFn = await this.leaf.subscribe(
      this.id,
      {
        name: "metadata",
        params: {},
        start,
        limit: 2500,
      },
      async (result) => {
        if ("Ok" in result) {
          // TODO: WE don't really know at this point that backfiling is done, so we need to refine
          // this later with a way to get from the server that we have finished.
          this.backfillStatus = { status: "finished" };
          this.#doneBackfilling.resolve();

          const events = parseEvents(result.Ok);
          this.eventChannel.push({
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
  }

  get doneBackfilling(): Promise<void> {
    return this.#doneBackfilling.promise;
  }

  async unsubscribe() {
    if (this.unsubscribeFn) {
      await this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
  }

  async fetchEvents(
    start: number,
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
  console.log("Trying to parse rows", rows);

  return rows.map((row) => {
    const result = encodedStreamEvent(row);

    if (result instanceof type.errors) {
      console.error("Could not parse event", result);
      throw new Error("Invalid column names for events response");
    }

    return {
      idx: Number(result.idx.value) as StreamIndex,
      user: result.user!.value,
      payload: result.payload?.value,
    };
  });
}
