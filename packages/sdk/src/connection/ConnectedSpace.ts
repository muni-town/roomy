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
  type Result,
  type SubscribeEventsResp,
} from "@muni-town/leaf-client";
import { decode, encode } from "@atcute/cbor";

import {
  StreamDid,
  StreamIndex,
  UserDid,
  Ulid,
  newUlid,
  parseEvent,
  type,
  Event,
} from "../schema";

import { Deferred } from "../utils/Deferred";
import { stateMachine, type StateMachine } from "../utils/TrackableState";
import type {
  ConnectedSpaceConfig,
  DecodedStreamEvent,
  EncodedStreamEvent,
  EventCallback,
  EventCallbackMeta,
  BackfillStatus,
} from "./types";

import { withTimeoutWarning } from "../utils/timeout";
import {
  SpaceMetaSynthetic,
  ProfileSynthetic,
} from "../schema/events/synthetic";
import { unwrapSqlRows } from "./sqlParsing";

export type ConnectionState =
  | { state: "connected" }
  | { state: "disconnected" };

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
  readonly connection: StateMachine<ConnectionState>;

  #leaf: LeafClient;
  #agent: Agent;
  #config: ConnectedSpaceConfig;

  #eventSubscription: (() => Promise<void>) | null = null;
  #metadataSubscription: (() => Promise<void>) | null = null;
  #backfillStatus: BackfillStatus = { status: "pending" };
  #callback: EventCallback | null = null;
  #metadataCallback: EventCallback | null = null;
  #doneBackfilling = new Deferred<Ulid>();

  #lastEventIdx: StreamIndex | null = null;
  #lastMetadataIdx: StreamIndex | null = null;

  /** Tracks lazy loading cursors per room */
  #roomCursors: Map<string, StreamIndex> = new Map();

  private constructor(config: ConnectedSpaceConfig) {
    this.streamDid = config.streamDid;
    this.#config = config;
    this.#agent = config.client.agent;
    this.#leaf = config.client.leaf;
    this.connection = stateMachine<ConnectionState>({ state: "connected" });

    this.#leaf.on("connect", () => this.#onConnect());
    this.#leaf.on("disconnect", () => this.#onDisconnect());
  }

  /**
   * Connect to an existing space stream.
   * Validates the stream exists and updates the module if needed.
   */
  static async connect(config: ConnectedSpaceConfig): Promise<ConnectedSpace> {
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
      console.debug(
        `Module for stream ${config.streamDid} (${previousModuleCid}) differs from expected (${expectedCid}), trying to update...`,
      );

      if (!(await config.client.leaf.hasModule(expectedCid))) {
        console.log("Leaf server doesn't have module, uploading:", {
          streamDid: config.streamDid,
          expectedCid,
        });
        await config.client.leaf.uploadModule(config.module.def);
      }

      try {
        await config.client.leaf.updateModule(config.streamDid, expectedCid);
        console.info(
          `Updated stream ( ${config.streamDid} ) module to ${expectedCid}`,
        );
      } catch (e) {
        if (previousModuleCid) {
          // May fail if user is not admin, which is fine
          console.warn(
            `Could not update space module ${config.streamDid} (user may not be admin):`,
            e,
          );
        } else {
          // If we couldn't get a previous module, and we couldn't update it, then something is
          // wrong with the stream, or it doesn't exist.
          throw new Error(
            `Stream may not exist on this Leaf server. Stream ID: ${config.streamDid}\n \
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
      (result) => this.#handleEventResult(result),
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
    this.#metadataCallback = callback;
    const doneBackfilling = new Deferred<StreamIndex>();

    this.#metadataSubscription = await this.#leaf.subscribeEvents(
      this.streamDid,
      {
        name: "metadata",
        params: {},
        start,
        limit: 2500,
      },
      (result) => this.#handleMetadataResult(result, doneBackfilling),
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
    this.#callback = null;
    this.#metadataCallback = null;
    this.#lastEventIdx = null;
    this.#lastMetadataIdx = null;

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
  ): Promise<{
    events: DecodedStreamEvent[];
    profiles: Array<typeof ProfileSynthetic.schema.infer>;
  }> {
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

    const { events: encodedEvents, profiles } = parseRoomRows(resp);
    const events = this.#decodeAndParseEvents(encodedEvents);
    events.reverse(); // events return with most recent first; putting them first>last should make materialisation more performant

    return { events, profiles };
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
  ): Promise<{
    events: DecodedStreamEvent[];
    profiles: Array<typeof ProfileSynthetic.schema.infer>;
  }> {
    const lazyEndIdx = this.#roomCursors.get(roomId);
    // If end is provided and we've already fetched past it, return empty
    if (end && lazyEndIdx && end >= lazyEndIdx) {
      console.log(
        "[ConnectedSpace.lazyLoadRoom] already fetched past end, returning []",
      );
      return { events: [], profiles: [] };
    }

    // Use provided end, or use cursor if we have one
    const oldestEnd = end || lazyEndIdx;
    if (oldestEnd) {
      this.#roomCursors.set(roomId, oldestEnd);
    }

    // console.log("[ConnectedSpace.lazyLoadRoom] calling fetchRoom with", {
    //   roomId,
    //   limit,
    //   end: oldestEnd,
    // });
    const { events, profiles } = await this.fetchRoom(roomId, limit, oldestEnd);

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

    return { events, profiles };
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
   * Send multiple events to this space in a single batch.
   * More efficient than calling sendEvent multiple times.
   */
  async sendEvents(events: Event[]): Promise<void> {
    if (events.length === 0) return;
    await this.#leaf.sendEvents(
      this.streamDid,
      events.map((event) => encode(event)),
    );
  }

  /**
   * Current backfill status.
   */
  get backfillStatus(): BackfillStatus {
    return this.#backfillStatus;
  }

  /**
   * Promise that resolves when backfill completes. Returns a unique batch ID for the final batch of backfilled events.
   */
  get doneBackfilling(): Promise<Ulid> {
    return this.#doneBackfilling.promise;
  }

  #handleEventResult(result: Result<SubscribeEventsResp>): void {
    if ("Ok" in result) {
      const events = this.#decodeAndParseEvents(parseRows(result.Ok.rows));
      const batchId = newUlid();

      if (events.length > 0) {
        const maxIdx = events.reduce(
          (max, e) => Math.max(max, e.idx) as StreamIndex,
          0 as StreamIndex,
        );
        this.#lastEventIdx = maxIdx;

        if (this.#callback) {
          const meta: EventCallbackMeta = {
            isBackfill: this.#backfillStatus.status !== "finished",
            streamDid: this.streamDid,
            batchId,
          };
          this.#callback(events, meta);
        }
      }

      if (!result.Ok.has_more) {
        this.#backfillStatus = { status: "finished" };
        this.#doneBackfilling.resolve(batchId);
      }
    } else {
      console.error("Subscribe query error:", result.Err);
      this.#backfillStatus = { status: "errored", error: result.Err };
    }
  }

  #handleMetadataResult(
    result: Result<SubscribeEventsResp>,
    doneBackfilling?: Deferred<StreamIndex>,
  ): void {
    if ("Ok" in result) {
      const events = this.#decodeAndParseEvents(parseRows(result.Ok.rows));

      if (events.length > 0) {
        const maxIdx = events.reduce(
          (max, e) => Math.max(max, e.idx) as StreamIndex,
          0 as StreamIndex,
        );
        this.#lastMetadataIdx = maxIdx;

        if (this.#metadataCallback) {
          const meta: EventCallbackMeta = {
            isBackfill: true,
            streamDid: this.streamDid,
            batchId: newUlid(),
          };
          this.#metadataCallback(events, meta);
        }
      }

      if (!result.Ok.has_more) {
        console.debug("Done backfilling metadata", {
          streamDid: this.streamDid,
          latest: this.#lastMetadataIdx,
        });
        doneBackfilling?.resolve(this.#lastMetadataIdx ?? (0 as StreamIndex));
      }
    } else {
      console.error("Metadata subscribe error:", result.Err);
    }
  }

  #onConnect(): void {
    console.info("ConnectedSpace: reconnected", { streamDid: this.streamDid });
    this.connection.current = { state: "connected" };
    this.#resubscribe();
  }

  #onDisconnect(): void {
    console.info("ConnectedSpace: disconnected", { streamDid: this.streamDid });
    this.connection.current = { state: "disconnected" };
    // Server-side subscriptions are already dead; null out without calling unsubscribe
    this.#eventSubscription = null;
    this.#metadataSubscription = null;
  }

  async #resubscribe(): Promise<void> {
    if (this.#callback && !this.#eventSubscription) {
      const start = ((this.#lastEventIdx ?? 0) + 1) as StreamIndex;
      console.info("ConnectedSpace: resubscribing to events", {
        streamDid: this.streamDid,
        start,
      });
      this.#eventSubscription = await this.#leaf.subscribeEvents(
        this.streamDid,
        {
          name: "events",
          params: {},
          start,
          limit: 2500,
        },
        (result) => this.#handleEventResult(result),
      );
    }

    if (this.#metadataCallback && !this.#metadataSubscription) {
      const start = ((this.#lastMetadataIdx ?? 0) + 1) as StreamIndex;
      console.info("ConnectedSpace: resubscribing to metadata", {
        streamDid: this.streamDid,
        start,
      });
      this.#metadataSubscription = await this.#leaf.subscribeEvents(
        this.streamDid,
        {
          name: "metadata",
          params: {},
          start,
          limit: 2500,
        },
        (result) => this.#handleMetadataResult(result),
      );
    }
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

  /**
   * Fetch space metadata as a synthetic event.
   * Returns null if the query fails (e.g., space doesn't support it).
   */
  async fetchSpaceMeta(): Promise<
    typeof SpaceMetaSynthetic.schema.infer | null
  > {
    try {
      const resp = await this.#leaf.query(this.streamDid, {
        name: "space_meta",
        params: {},
      });

      if (!resp || resp.length === 0) {
        console.warn("[ConnectedSpace] space_meta query returned no results");
        return null;
      }

      // The query returns a single row with a payload field
      const row = resp[0];
      if (!row) {
        console.warn("[ConnectedSpace] space_meta query returned empty row");
        return null;
      }
      const payloadValue = row.payload;

      // Handle different payload formats from Leaf
      let eventData: unknown;

      if (typeof payloadValue === "string") {
        // JSON string - parse it
        eventData = JSON.parse(payloadValue);
      } else if (payloadValue instanceof Uint8Array) {
        // CBOR bytes - decode them
        eventData = decode(payloadValue);
      } else if (
        payloadValue &&
        typeof payloadValue === "object" &&
        "$type" in payloadValue
      ) {
        // SQLite value wrapper - extract the actual value
        if ("value" in payloadValue) {
          const wrappedValue = (payloadValue as { value: unknown }).value;

          if (typeof wrappedValue === "string") {
            eventData = JSON.parse(wrappedValue);
          } else if (wrappedValue instanceof Uint8Array) {
            eventData = decode(wrappedValue);
          } else {
            eventData = wrappedValue;
          }
        } else {
          // Already a decoded object (no value wrapper)
          eventData = payloadValue;
        }
      } else {
        console.error(
          "[ConnectedSpace] Unexpected payload type from space_meta:",
          typeof payloadValue,
          payloadValue,
        );
        return null;
      }

      // Validate using the synthetic event schema
      const result = SpaceMetaSynthetic.schema(eventData);

      if (result instanceof type.errors) {
        console.error(
          "[ConnectedSpace] Failed to validate space_meta event:",
          result.summary,
        );
        return null;
      }

      return result;
    } catch (e) {
      console.warn(
        "[ConnectedSpace] Failed to fetch space_meta, space may not support it yet:",
        e,
      );
      return null;
    }
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

// Arktype schema for unwrapped event row values
const unwrappedEventSchema = type({
  idx: "number",
  user: "string",
  payload: type.instanceOf(Uint8Array),
});

/**
 * Parse unwrapped SQL row values into an encoded stream event.
 */
function parseEventRow(unwrapped: unknown): EncodedStreamEvent {
  const result = unwrappedEventSchema(unwrapped);
  if (result instanceof type.errors) {
    console.error("Could not parse event row", result);
    throw new Error("Invalid event row structure");
  }

  return {
    idx: result.idx as StreamIndex,
    user: UserDid.assert(result.user),
    payload: result.payload,
  };
}

function parseRows(rows: SqlRows): EncodedStreamEvent[] {
  const unwrapped = unwrapSqlRows(rows);
  return unwrapped.map(parseEventRow);
}

// Arktype schema for unwrapped room row values
const unwrappedRoomRowSchema = type({
  idx: "number",
  user: "string",
  payload: type.instanceOf(Uint8Array),
  profile: "string", // JSON string containing synthetic event
});

/**
 * Parse room query result, extracting both events and profile synthetic events.
 */
function parseRoomRows(rows: SqlRows): {
  events: EncodedStreamEvent[];
  profiles: Array<typeof ProfileSynthetic.schema.infer>;
} {
  const events: EncodedStreamEvent[] = [];
  const profiles: Array<typeof ProfileSynthetic.schema.infer> = [];

  const unwrapped = unwrapSqlRows(rows);

  for (const row of unwrapped) {
    const result = unwrappedRoomRowSchema(row);
    if (result instanceof type.errors) {
      console.error("Could not parse room row", result);
      throw new Error("Invalid room row structure");
    }

    // Parse event columns (idx, user, payload)
    events.push({
      idx: result.idx as StreamIndex,
      user: UserDid.assert(result.user),
      payload: result.payload,
    });

    // Parse profile synthetic event
    try {
      const profile = JSON.parse(result.profile);
      // Validate with Arktype
      const validated = ProfileSynthetic.schema(profile);
      if (validated instanceof type.errors) {
        console.warn("Invalid profile structure", validated);
        continue;
      }
      profiles.push(validated);
    } catch (e) {
      console.warn("Failed to parse profile JSON", result.profile, e);
    }
  }

  return { events, profiles };
}
