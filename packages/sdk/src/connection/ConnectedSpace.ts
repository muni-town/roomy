/**
 * ConnectedSpace - Manages a connection to a Roomy space stream.
 *
 * Handles ATProto authentication, Leaf subscriptions, backfill management,
 * and event decoding. Consumers receive decoded events via callbacks.
 */

import type { Agent } from "@atproto/api";
import {
  LeafClient,
  type LeafQuery,
  type SqlRows,
} from "@muni-town/leaf-client";
import { decode, encode } from "@atcute/cbor";

import {
  StreamDid,
  StreamIndex,
  UserDid,
  Ulid,
  newUlid,
  parseEvent,
  type Event,
  type,
} from "../schema";

import { Deferred } from "../utils/Deferred";
import type {
  ConnectedSpaceConfig,
  DecodedStreamEvent,
  EncodedStreamEvent,
  EventCallback,
  EventCallbackMeta,
  BackfillStatus,
} from "./types";
import { withTimeoutWarning } from "../utils/timeout";

/**
 * Manages a connection to a Roomy space stream.
 *
 * @example
 * ```ts
 * const space = await ConnectedSpace.connect({
 *   agent,
 *   leafUrl: "https://leaf.example.com",
 *   leafDid: "did:web:leaf.example.com",
 *   streamDid: StreamDid.assert("did:key:..."),
 *   module: modules.space,
 * });
 *
 * await space.subscribe((events, { isBackfill }) => {
 *   for (const { event } of events) {
 *     console.log(event.$type, event);
 *   }
 * });
 * ```
 */
export class ConnectedSpace {
  readonly streamDid: StreamDid;

  #leaf: LeafClient;
  #agent: Agent;
  #config: ConnectedSpaceConfig;

  #eventSubscription: (() => Promise<void>) | null = null;
  #metadataSubscription: (() => Promise<void>) | null = null;
  #backfillStatus: BackfillStatus = { status: "pending" };
  #callback: EventCallback | null = null;
  #doneBackfilling = new Deferred<Ulid>();

  /** Tracks lazy loading cursors per room */
  #roomCursors: Map<string, StreamIndex> = new Map();

  private constructor(config: ConnectedSpaceConfig) {
    this.streamDid = config.streamDid;
    this.#config = config;
    this.#agent = config.client.agent;
    this.#leaf = config.client.leaf;
  }

  /**
   * Connect to an existing space stream.
   * Validates the stream exists and updates the module if needed.
   */
  static async connect(config: ConnectedSpaceConfig): Promise<ConnectedSpace> {
    console.debug("Connecting", config);

    let previousModuleCid: undefined | string;
    try {
      const { moduleCid: cid } = await config.client.leaf.streamInfo(
        config.streamDid,
      );
      previousModuleCid = cid;
      console.debug("Got stream info", { moduleCid: previousModuleCid });
    } catch (e) {
      console.warn(
        "Stream info error ( will try to reset module if possible ):",
        e,
      );
    }
    const expectedCid = await config.module.cid;

    if (previousModuleCid !== expectedCid) {
      console.info(
        `Module for stream ${config.streamDid} (${previousModuleCid}) differs from expected (${expectedCid}), trying to update...`,
      );

      if (!(await config.client.leaf.hasModule(expectedCid))) {
        console.log("Leaf server doesn't have module, uploading:", expectedCid);
        await config.client.leaf.uploadModule(config.module.def);
      }

      try {
        await config.client.leaf.updateModule(config.streamDid, expectedCid);
        console.log(
          `Updated stream ( ${config.streamDid} ) module to ${expectedCid}`,
        );
      } catch (e) {
        if (previousModuleCid) {
          // May fail if user is not admin, which is fine
          console.warn(
            "Could not update space module (user may not be admin):",
            e,
          );
        } else {
          // If we couldn't get a previous module, and we couldn't update it, then something is
          // wrong with the stream, or it doesn't exist.
          throw new Error(
            `Stream does not exist on this Leaf server. Stream ID: ${config.streamDid}\n \
            Tried to update module bug got error: ${e}`,
          );
        }
      }
    }

    return new ConnectedSpace(config);
  }

  /**
   * Create a new space stream and connect to it.
   */
  static async create(
    config: Omit<ConnectedSpaceConfig, "streamDid">,
    adminDid: UserDid,
  ): Promise<ConnectedSpace> {
    try {
      console.log("Creating stream");
      const cid = await config.module.cid;

      if (!(await config.client.leaf.hasModule(cid))) {
        console.info("Leaf server does not have module yet. Uploading:", cid);
        await config.client.leaf.uploadModule(config.module.def);
      }

      console.debug("Module ready to create stream");
      const { streamDid } = await config.client.leaf.createStream(cid);
      console.log("Created stream:", streamDid);

      // Send addAdmin event for the creator
      await config.client.leaf.sendEvent(
        streamDid,
        encode({
          id: newUlid(),
          $type: "space.roomy.space.addAdmin.v0",
          userDid: adminDid,
        } satisfies Event),
      );

      const fullConfig = {
        ...config,
        streamDid: StreamDid.assert(streamDid),
      };

      return new ConnectedSpace(fullConfig);
    } catch (e) {
      console.error("Error creating space stream", e);
      throw e;
    }
  }

  /**
   * Subscribe to events from this space.
   * Backfills historical events first, then receives live updates.
   *
   * @param callback - Called with batches of decoded events
   * @param start - Stream index to start from (default: 0 for full backfill)
   * @returns Promise that resolves when backfill completes
   */
  async subscribe(
    callback: EventCallback,
    start: StreamIndex = 1 as StreamIndex,
  ): Promise<Ulid> {
    this.#callback = callback;

    this.#eventSubscription = await this.#leaf.subscribeEvents(
      this.streamDid,
      {
        name: "events",
        params: {},
        start,
        limit: 2500,
      },
      async (result) => {
        if ("Ok" in result) {
          const events = this.#decodeAndParseEvents(parseRows(result.Ok.rows));
          const batchId = newUlid();

          if (events.length > 0 && this.#callback) {
            const meta: EventCallbackMeta = {
              isBackfill: this.#backfillStatus.status !== "finished",
              streamDid: this.streamDid,
              batchId,
            };
            this.#callback(events, meta);
          }

          if (!result.Ok.has_more) {
            this.#backfillStatus = { status: "finished" };
            this.#doneBackfilling.resolve(batchId);
          }
        } else {
          console.error("Subscribe query error:", result.Err);
          this.#backfillStatus = { status: "errored", error: result.Err };
        }
      },
    );

    this.#backfillStatus = { status: "started" };
    return withTimeoutWarning(
      this.#doneBackfilling.promise,
      "Still waiting for events to backfill...",
    );
  }

  /**
   * Subscribe to metadata events only.
   * Returns the latest event index after backfill completes.
   */
  async subscribeMetadata(
    callback: EventCallback,
    start: number = 0,
  ): Promise<StreamIndex> {
    const doneBackfilling = new Deferred<StreamIndex>();
    let latest = 0 as StreamIndex;

    this.#metadataSubscription = await this.#leaf.subscribeEvents(
      this.streamDid,
      {
        name: "metadata",
        params: {},
        start,
        limit: 2500,
      },
      async (result) => {
        if ("Ok" in result) {
          const events = this.#decodeAndParseEvents(parseRows(result.Ok.rows));

          if (events.length > 0) {
            const meta: EventCallbackMeta = {
              isBackfill: true,
              streamDid: this.streamDid,
              batchId: newUlid(),
            };
            callback(events, meta);

            const latestEvent = events
              .map((x) => x.idx)
              .reduce(
                (x, y) => Math.max(x, y) as StreamIndex,
                0 as StreamIndex,
              );
            latest = latestEvent || latest;
          }

          if (!result.Ok.has_more) {
            console.debug("Done backfilling metadata", {
              streamDid: this.streamDid,
              latest,
            });
            doneBackfilling.resolve(latest);
          }
        } else {
          console.error("Metadata subscribe error:", result.Err);
        }
      },
    );

    return withTimeoutWarning(
      doneBackfilling.promise,
      "Still waiting for metadata backfill...",
    );
  }

  /**
   * Unsubscribe from event updates.
   */
  async unsubscribe(): Promise<void> {
    if (this.#eventSubscription) {
      await this.#eventSubscription();
      this.#eventSubscription = null;
    }
    if (this.#metadataSubscription) {
      await this.#metadataSubscription();
      this.#metadataSubscription = null;
    }
  }

  /**
   * Fetch events from a specific room.
   */
  async fetchRoom(
    roomId: Ulid,
    limit: number,
    end?: StreamIndex,
  ): Promise<DecodedStreamEvent[]> {
    const params: LeafQuery["params"] = {
      room: { $type: "muni.town.sqliteValue.text", value: roomId },
    };
    if (end !== undefined) {
      params["end"] = { $type: "muni.town.sqliteValue.integer", value: end };
    }

    const resp = await this.#leaf.query(this.streamDid, {
      name: "room",
      params,
      limit,
    });

    const events = this.#decodeAndParseEvents(parseRows(resp));
    events.reverse();
    return events;
  }

  /**
   * Lazy load events from a room for pagination.
   * Tracks cursor position to avoid duplicate fetches.
   *
   * @param roomId - Room to fetch for
   * @param limit - Number of events to fetch
   * @param end - Fetch events before this index (for pagination)
   * @returns Events callback will be invoked if new events are fetched
   */
  async lazyLoadRoom(
    roomId: Ulid,
    limit: number,
    end?: StreamIndex,
  ): Promise<DecodedStreamEvent[]> {
    const lazyEndIdx = this.#roomCursors.get(roomId);
    const alreadyFetched =
      (!end && lazyEndIdx) || (end && lazyEndIdx && end >= lazyEndIdx);

    if (alreadyFetched) {
      return [];
    }

    const oldestEnd = end || lazyEndIdx;
    if (oldestEnd) {
      this.#roomCursors.set(roomId, oldestEnd);
    }

    const events = await this.fetchRoom(roomId, limit, end);

    if (!end && events.length > 0) {
      // Set cursor to the oldest event for initial load
      const actualEnd = events
        .map((x) => x.idx)
        .reduce(
          (a, b) => Math.min(a, b) as StreamIndex,
          Infinity as StreamIndex,
        );
      if (actualEnd !== Infinity) {
        this.#roomCursors.set(roomId, actualEnd as StreamIndex);
      }
    }

    return events;
  }

  /**
   * Fetch events starting from a specific index.
   */
  async fetchEvents(
    start: StreamIndex,
    limit: number,
  ): Promise<DecodedStreamEvent[]> {
    const resp = await this.#leaf.query(this.streamDid, {
      name: "events",
      params: {},
      limit,
      start,
    });
    return this.#decodeAndParseEvents(parseRows(resp));
  }

  /**
   * Fetch link events (createRoomLink, removeRoomLink).
   *
   * @param start - Starting event index
   * @param limit - Maximum number of events to return
   * @param room - Optional room ID to filter by (returns links posted in this room)
   * @returns Decoded link events
   */
  async fetchLinks(
    start: StreamIndex,
    limit: number,
    room?: Ulid,
  ): Promise<DecodedStreamEvent[]> {
    const params: LeafQuery["params"] = {};
    if (room !== undefined) {
      params["room"] = { $type: "muni.town.sqliteValue.text", value: room };
    }

    const resp = await this.#leaf.query(this.streamDid, {
      name: "links",
      params,
      limit,
      start,
    });
    return this.#decodeAndParseEvents(parseRows(resp));
  }

  /**
   * Send an event to this space.
   */
  async sendEvent(event: Event): Promise<void> {
    await this.#leaf.sendEvent(this.streamDid, encode(event));
  }

  /**
   * Current backfill status.
   */
  get backfillStatus(): BackfillStatus {
    return this.#backfillStatus;
  }

  /**
   * Promise that resolves when backfill completes.
   */
  get doneBackfilling(): Promise<Ulid> {
    return this.#doneBackfilling.promise;
  }

  /**
   * Decode CBOR payloads and parse events.
   */
  #decodeAndParseEvents(events: EncodedStreamEvent[]): DecodedStreamEvent[] {
    return events
      .map((e) => {
        try {
          const payloadBytes = new Uint8Array(e.payload);
          return { ...e, decoded: decode(payloadBytes) };
        } catch (error) {
          console.warn(
            `Skipping malformed event (idx ${e.idx}): Failed to decode.`,
            { event: e, error, streamDid: this.streamDid },
          );
          return null;
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .map((e) => {
        try {
          const result = parseEvent(e.decoded);
          if (result.success) {
            return {
              idx: e.idx,
              event: result.data,
              user: e.user,
            };
          }
          throw new Error(result.error);
        } catch (error) {
          console.warn(
            `Skipping malformed event (idx ${e.idx}): Failed to parse.`,
            { event: e, error, streamDid: this.streamDid },
          );
          return null;
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
  }
}

/**
 * Create a LeafClient with ATProto service auth.
 */
function createLeafClient(config: {
  agent: Agent;
  leafUrl: string;
  leafDid: string;
}): LeafClient {
  return new LeafClient(config.leafUrl, async () => {
    const resp = await config.agent.com.atproto.server.getServiceAuth({
      aud: config.leafDid,
      lxm: "town.muni.leaf.authenticate",
    });
    return resp.data.token;
  });
}

/**
 * Parse SQL rows into encoded stream events.
 */
const encodedStreamEventType = type({
  idx: { $type: "'muni.town.sqliteValue.integer'", value: StreamIndex },
  user: { $type: "'muni.town.sqliteValue.text'", value: "string" },
  payload: {
    $type: "'muni.town.sqliteValue.blob'",
    value: type.instanceOf(Uint8Array),
  },
});

function parseRows(rows: SqlRows): EncodedStreamEvent[] {
  return rows.map((row) => {
    const result = encodedStreamEventType(row);

    if (result instanceof type.errors) {
      console.error("Could not parse event row", result);
      throw new Error("Invalid column names for events response");
    }

    return {
      idx: Number(result.idx.value) as StreamIndex,
      user: UserDid.assert(result.user!.value),
      payload: result.payload?.value,
    };
  });
}
