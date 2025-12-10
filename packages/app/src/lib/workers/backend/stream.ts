import { Deferred } from "$lib/utils/deferred";
import type { LeafClient, SqlRows } from "@muni-town/leaf-client";
import type {
  Batch,
  EncodedStreamEvent,
  StreamHashId,
  StreamIndex,
  TaskPriority,
  Ulid,
} from "../types";
import type { AsyncChannel } from "../asyncChannel";
import type { Did } from "@atproto/api";
import { ulid } from "ulidx";
import { personalModule, spaceModule } from "./modules";

interface ConnectedStreamOpts {
  user: Did;
  leaf: LeafClient;
  id: StreamHashId;
  idx: StreamIndex;
  eventChannel: AsyncChannel<Batch.Event>;
  priority?: TaskPriority;
}

export class ConnectedStream {
  user: Did;
  leaf: LeafClient;
  id: StreamHashId;
  pin: PinState;
  eventChannel: AsyncChannel<Batch.Event>;
  unsubscribeFn: (() => Promise<void>) | null = null;

  private constructor(opts: {
    user: Did;
    leaf: LeafClient;
    id: StreamHashId;
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
  static async new(opts: ConnectedStreamOpts) {
    const streamInfo = await opts.leaf.streamInfo(opts.id);
    if (!streamInfo)
      throw new Error(
        "Stream does not exist (on this Leaf server): " + opts.id,
      );
    return ConnectedStream.assert(opts);
  }

  static async createSpace(opts: Omit<ConnectedStreamOpts, "id" | "idx">) {
    const moduleId = await opts.leaf.uploadModule(spaceModule.encoded.buffer);

    const streamId = await opts.leaf.createStream({
      stamp: ulid(),
      creator: opts.user,
      module: moduleId,
      options: [],
    });
    return await ConnectedStream.new({
      ...opts,
      id: streamId as StreamHashId,
      idx: 0 as StreamIndex,
    });
  }

  static async createPersonal(
    opts: Omit<ConnectedStreamOpts, "id" | "idx" | "priority">,
  ) {
    const moduleId = await opts.leaf.uploadModule(
      personalModule.encoded.buffer,
    );

    console.log("uploaded personal module:", moduleId);

    const streamId = await opts.leaf.createStream({
      stamp: ulid(),
      creator: opts.user,
      module: moduleId,
      options: [],
    });

    console.log("created personal stream:", streamId);

    return ConnectedStream.assert({
      ...opts,
      id: streamId as StreamHashId,
      idx: 0 as StreamIndex,
      priority: "priority",
    });
  }

  async subscribe() {
    this.unsubscribeFn = await this.leaf.subscribe(
      this.id,
      {
        query_name: "events",
        requesting_user: this.user,
        params: [],
        start: BigInt(this.pin.backfill.upToEventId + 1),
        limit: 1n,
      },
      async (result) => {
        if (result.success) {
          const events = parseEvents(result.value);
          for (const event of events) {
            this.eventChannel.push({
              status: "pushed",
              batchId: ulid() as Ulid,
              streamId: this.id as StreamHashId,
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
      query_name: "events",
      limit: BigInt(limit),
      start: BigInt(start),
      params: [],
      requesting_user: this.user,
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
          batchId: ulid() as Ulid,
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
    rooms: Map<StreamHashId, BackfillState>;
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

export function parseEvents(rows: SqlRows): EncodedStreamEvent[] {
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
