import { Deferred } from "$lib/utils/deferred";
import type { LeafClient, SqlRows, SqlValueRaw } from "@muni-town/leaf-client";
import type {
  Batch,
  EncodedStreamEvent,
  StreamIndex,
  TaskPriority,
} from "../types";
import type { AsyncChannel } from "../asyncChannel";
import { personalModule, spaceModule } from "./modules";
import {
  didStream,
  newUlid,
  streamIndex,
  type,
  type DidStream,
  type DidUser,
  type Event,
} from "$lib/schema";
import { encode } from "@atcute/cbor";

interface ConnectedStreamOpts {
  user: DidUser;
  leaf: LeafClient;
  id: DidStream;
  idx: StreamIndex;
  eventChannel: AsyncChannel<Batch.Event>;
  priority?: TaskPriority;
}

export class ConnectedStream {
  user: DidUser;
  leaf: LeafClient;
  id: DidStream;
  pin: PinState;
  eventChannel: AsyncChannel<Batch.Event>;
  unsubscribeFn: (() => Promise<void>) | null = null;

  private constructor(opts: {
    user: DidUser;
    leaf: LeafClient;
    id: DidStream;
    pin: PinState;
    eventChannel: AsyncChannel<Batch.Event>;
  }) {
    this.user = opts.user;
    this.leaf = opts.leaf;
    this.id = opts.id;
    this.pin = opts.pin;
    this.eventChannel = opts.eventChannel;
  }

  /** Sync factory for where stream existence doesn't need checking */
  static assert(opts: ConnectedStreamOpts) {
    return new ConnectedStream({
      user: opts.user,
      leaf: opts.leaf,
      id: opts.id,
      pin: new PinStateSpace({ idx: opts.idx, priority: opts.priority }),
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
        id: didStream.assert(streamDid),
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
        id: didStream.assert(streamDid),
        idx: 0 as StreamIndex,
        priority: "priority",
      });
    } catch (e) {
      console.error("Error creating personal stream", e);
      throw e;
    }
  }

  async subscribe() {
    this.unsubscribeFn = await this.leaf.subscribe(
      this.id,
      {
        name: "events",
        params: {},
        start: this.pin.backfill.upToEventId + 1,
        limit: 1,
      },
      async (result) => {
        if ("Ok" in result) {
          const events = parseEvents(result.Ok);
          for (const event of events) {
            this.eventChannel.push({
              status: "pushed",
              batchId: newUlid(),
              streamId: this.id as DidStream,
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
        } else {
          console.error("Subscribed query error:", result.Err);
        }
      },
    );
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

  updateStreamCursor(idx: StreamIndex) {
    this.pin.backfill.upToEventId = idx;
  }

  async backfill() {
    // Unsubscribe from the stream during backfill if we have a subscription already
    await this.unsubscribe();

    console.log(
      `stream ${this.id} backfilled to ${this.pin.backfill.upToEventId}`,
    );

    await this.pin.backfill.backfill(
      async (idx: StreamIndex, batchSize: number) => {
        console.time("fetchBatch-" + this.id);
        return await this.fetchEvents(idx, batchSize);
      },
      (events: EncodedStreamEvent[], priority) => {
        this.eventChannel.push({
          status: "fetched",
          batchId: newUlid(),
          streamId: this.id,
          events,
          priority,
        });
        console.timeEnd("fetchBatch-" + this.id);
      },
    );

    // Resubscribe to the stream after backfill
    await this.subscribe();

    console.log("Finished backfill for stream", this.id);
  }
}

type PinState = PinStates.Space; // Currently only full-space pinning supported

namespace PinStates {
  export interface Rooms {
    type: "rooms";
    rooms: Map<DidStream, BackfillState>;
  }

  export interface Space {
    type: "space";
    backfill: BackfillState;
  }
}

class PinStateSpace implements PinStates.Space {
  type: "space" = "space";
  backfill: BackfillState;

  constructor(opts: { idx?: StreamIndex; priority?: TaskPriority }) {
    this.backfill = new BackfillState(
      opts.idx || (0 as StreamIndex),
      opts.priority || "background",
    );
  }
}

export type BackfillStateType =
  | BackfillStates.Error
  | BackfillStates.Initial
  | BackfillStates.Backfilling
  | BackfillStates.Idle;

namespace BackfillStates {
  export interface Error {
    __brand: "backfillError";
    status: "error";
    message: string;
  }

  export interface Initial {
    status: "initial";
    completed: Deferred;
  }

  export interface Backfilling {
    status: "backfilling";
    completed: Deferred;
  }

  export interface Idle {
    status: "idle";
  }
}

// ideally we have a structured way to keep this in sync with the db...
class BackfillState {
  #status: BackfillStateType;
  upToEventId: StreamIndex;
  priority: TaskPriority;
  batchSize = 2500;

  constructor(from: StreamIndex, priority: TaskPriority) {
    this.#status = {
      status: "initial",
      completed: new Deferred(),
    };
    this.upToEventId = from;
    this.priority = priority;
  }

  get status() {
    return this.#status.status;
  }

  get completed() {
    if (this.#status.status === "error") {
      throw new Error("No backfill in progress to await completion for");
    }
    if (this.#status.status === "idle") return Promise.resolve();
    return this.#status.completed.promise;
  }

  private continue(value: StreamIndex) {
    if (value < this.upToEventId) {
      throw new Error(
        "Cannot set backfill upToEventId to an earlier value, must be monotonic.",
      );
    }
    this.upToEventId = value;
  }

  finish(to: StreamIndex) {
    if (this.#status.status === "error") {
      throw new Error("Cannot finish backfill in error state");
    }
    if (this.#status.status === "idle") {
      throw new Error("Cannot finish backfill that is not in progress");
    }
    if (to < this.upToEventId) {
      throw new Error("Cannot finish backfill to an earlier event ID");
    }

    this.#status.completed.resolve();
    this.#status = {
      status: "idle",
    };
    this.upToEventId = to;
  }

  async backfill(
    fetcher: (
      idx: StreamIndex,
      batchSize: number,
    ) => Promise<EncodedStreamEvent[]>,
    handler: (events: EncodedStreamEvent[], priority: TaskPriority) => void,
  ) {
    if (this.#status.status === "backfilling")
      throw new Error("Backfill already in progress");
    if (this.#status.status === "error") {
      throw new Error("Cannot start backfill in error state");
    }

    const completed =
      this.#status.status === "idle" ? new Deferred() : this.#status.completed;

    this.#status = {
      status: "backfilling",
      completed,
    };

    while (true) {
      const events = await fetcher(
        (this.upToEventId + 1) as StreamIndex,
        this.batchSize,
      );
      if (events.length === 0) {
        this.finish(this.upToEventId);
        break;
      }
      handler(events, this.priority);
      this.continue(events[events.length - 1]!.idx);
    }

    completed.resolve();
    this.#status = {
      status: "idle",
    };
  }
}

const encodedStreamEvent = type({
  idx: { $type: "'muni.town.sqliteValue.integer'", value: streamIndex },
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
      payload: result.payload?.value.buffer,
    };
  });
}
