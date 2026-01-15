/**
 * RoomyClient - High-level client for interacting with Roomy infrastructure.
 *
 * Wraps ATProto Agent and LeafClient, providing:
 * - Cached profile lookups
 * - Cached handle resolution
 * - Cached stream handle record lookups
 * - Space resolution from handles or DIDs
 * - PDS operations (blob uploads, records)
 *
 * Use the static `create()` method to instantiate - it waits for Leaf
 * authentication before returning, so all methods are ready to use.
 */

import type { Agent } from "@atproto/api";
import type { LeafClient } from "@muni-town/leaf-client";
import { Did, Handle, UserDid, StreamDid, type, newUlid } from "../schema";
import { Deferred } from "../utils/Deferred";
import { createLeafClient, type LeafConfig } from "../leaf";
import {
  getProfile,
  type Profile,
  uploadBlob,
  createStreamHandleRecord,
  removeStreamHandleRecord,
  getPersonalStreamId,
  savePersonalStreamId,
} from "../atproto";
import { ConnectedSpace } from "../connection/ConnectedSpace";
import { modules, type ModuleWithCid } from "../modules";
import { EventCallback } from "../connection";

export interface RoomyClientConfig extends LeafConfig {
  agent: Agent;
  /** Collection for personal space record, e.g., "space.roomy.space.personal.dev" */
  spaceNsid: string;
  /** Collection for space handle records, e.g., "space.roomy.space.handle.dev" */
  spaceHandleNsid: string;
}

export interface RoomyClientEvents {
  /** Called when Leaf connection is established */
  onConnect?: () => void;
  /** Called when Leaf connection is lost */
  onDisconnect?: () => void;
}

interface ProfileResponse {
  success: boolean;
  data: {
    did: string;
    handle: string;
    displayName?: string;
    description?: string;
    avatar?: string;
    banner?: string;
  };
}

export class RoomyClient {
  readonly agent: Agent;
  readonly leaf: LeafClient;
  readonly #config: RoomyClientConfig;

  // Caches
  readonly #profileCache = new Map<string, ProfileResponse>();
  readonly #streamHandleCache = new Map<string, StreamDid | undefined>();

  // Personal stream
  #personalStream: ConnectedSpace | null = null;

  /**
   * Get the connected personal stream, if any.
   */
  get personalStream(): ConnectedSpace | null {
    return this.#personalStream;
  }

  private constructor(config: RoomyClientConfig, leaf: LeafClient) {
    this.agent = config.agent;
    this.#config = config;
    this.leaf = leaf;
  }

  /**
   * Create a RoomyClient and wait for Leaf authentication.
   * Returns only when the client is fully ready to use.
   *
   * @param config - Client configuration
   * @param events - Optional event handlers for connection status
   */
  static async create(
    config: RoomyClientConfig,
    events?: RoomyClientEvents,
  ): Promise<RoomyClient> {
    const leaf = createLeafClient(config.agent, {
      leafUrl: config.leafUrl,
      leafDid: config.leafDid,
    });

    const authenticated = new Deferred<void>();

    leaf.on("connect", () => {
      console.info("Leaf: connected");
      events?.onConnect?.();
    });

    leaf.on("disconnect", () => {
      console.info("Leaf: disconnected");
      events?.onDisconnect?.();
    });

    leaf.on("authenticated", (did) => {
      console.info("Leaf: authenticated as", { did });
      authenticated.resolve();
    });

    // Wait for authentication before returning
    await authenticated.promise;

    return new RoomyClient(config, leaf);
  }

  /**
   * Get a profile, returning the simplified Profile type.
   */
  async getProfile(did?: Did): Promise<Profile | undefined> {
    return getProfile(this.agent, did);
  }

  /**
   * Get full profile response with caching.
   * Used internally for handle resolution.
   */
  async getProfileCached(actor: string): Promise<ProfileResponse> {
    const cached = this.#profileCache.get(actor);
    if (cached) return cached;

    const resp = await this.agent.getProfile({ actor });
    this.#profileCache.set(actor, resp as ProfileResponse);
    return resp as ProfileResponse;
  }

  /**
   * Resolve a handle to a DID using the cached profile lookup.
   */
  async resolveDidFromHandle(handle: Handle): Promise<UserDid> {
    const profile = await this.getProfileCached(handle);
    return profile.data.did as UserDid;
  }

  /**
   * Check if a stream exists on the Leaf server.
   */
  async checkStreamExists(streamId: StreamDid): Promise<boolean> {
    try {
      const streamInfo = await this.leaf.streamInfo(streamId);
      return !!streamInfo;
    } catch {
      return false;
    }
  }

  /**
   * Get stream handle record for a DID, with caching.
   * Verifies the stream exists before returning.
   */
  async getStreamHandleRecord(did: Did): Promise<StreamDid | undefined> {
    const cached = this.#streamHandleCache.get(did);
    if (cached !== undefined) return cached;

    try {
      const resp = await this.agent.com.atproto.repo.getRecord(
        {
          collection: this.#config.spaceHandleNsid,
          repo: did,
          rkey: "self",
        },
        {
          headers: {
            "atproto-proxy": `${did}#atproto_pds`,
          },
        },
      );

      const streamId = resp.data.value?.id
        ? StreamDid.assert(resp.data.value.id as string)
        : undefined;

      // Verify stream exists
      if (streamId) {
        const exists = await this.checkStreamExists(streamId);
        if (!exists) {
          console.warn(
            "Stream handle record points to non-existing stream, returning undefined",
          );
          this.#streamHandleCache.set(did, undefined);
          return undefined;
        }
      }

      this.#streamHandleCache.set(did, streamId);
      return streamId;
    } catch (e) {
      console.warn(
        "Could not get stream handle record, most likely does not exist",
        e,
      );
      this.#streamHandleCache.set(did, undefined);
      return undefined;
    }
  }

  /**
   * Create a stream handle record linking current user to a space.
   */
  async createStreamHandleRecord(spaceId: StreamDid): Promise<void> {
    await createStreamHandleRecord(this.agent, spaceId, {
      collection: this.#config.spaceHandleNsid,
    });
    // Invalidate cache for current user
    this.#streamHandleCache.delete(this.agent.assertDid);
  }

  /**
   * Remove the stream handle record for current user.
   */
  async removeStreamHandleRecord(): Promise<void> {
    await removeStreamHandleRecord(this.agent, {
      collection: this.#config.spaceHandleNsid,
    });
    // Invalidate cache for current user
    this.#streamHandleCache.delete(this.agent.assertDid);
  }

  /**
   * Resolve a space ID or handle to a space ID.
   * If given a handle, resolves via profile and stream handle record.
   */
  async resolveSpaceId(spaceIdOrHandle: StreamDid | Handle): Promise<{
    spaceId: StreamDid;
    handle?: Handle;
    did?: UserDid;
  }> {
    const idType = this.#parseIdType(spaceIdOrHandle);

    if (idType === "handle") {
      const did = await this.resolveDidFromHandle(spaceIdOrHandle as Handle);
      const spaceId = await this.getStreamHandleRecord(did);
      if (!spaceId) throw new Error("Could not resolve space ID from handle");
      return {
        spaceId,
        handle: spaceIdOrHandle as Handle,
        did,
      };
    }

    return { spaceId: spaceIdOrHandle as StreamDid };
  }

  /**
   * Resolve a handle for a space, verifying the handle points to this space.
   */
  async resolveHandleForSpace(
    spaceId: StreamDid,
    handleAccountDid: UserDid,
  ): Promise<Handle | undefined> {
    try {
      const profile = await this.getProfileCached(handleAccountDid);
      const handle = profile.data.handle as Handle;
      const resolved = await this.resolveSpaceId(
        handleAccountDid as unknown as Handle,
      );
      if (resolved.spaceId === spaceId) {
        return handle;
      }
    } catch (e) {
      console.warn("Error resolving handle for space", e);
    }
    return undefined;
  }

  /**
   * Get space info from the Leaf server.
   */
  async getSpaceInfo(
    streamDid: StreamDid,
  ): Promise<{ name?: string; avatar?: string } | undefined> {
    try {
      const resp = await this.leaf.query(streamDid, {
        name: "space_info",
        params: {},
      });
      const row = resp[0];
      if (!row) return undefined;

      const name =
        row.name?.$type === "muni.town.sqliteValue.text"
          ? row.name.value
          : undefined;
      const avatar =
        row.avatar?.$type === "muni.town.sqliteValue.text"
          ? row.avatar.value
          : undefined;

      return { name, avatar };
    } catch (error) {
      console.error("Failed to load space info", { streamDid, error });
      return undefined;
    }
  }

  /**
   * Upload a blob to the user's PDS.
   */
  async uploadBlob(
    bytes: ArrayBuffer,
    opts?: { alt?: string; mimetype?: string },
  ) {
    return uploadBlob(this.agent, bytes, opts);
  }

  /**
   * Connect to or create the user's personal stream.
   * Returns existing stream if already connected.
   *
   * @param module - Module definition for personal streams
   */
  async connectPersonalSpace(schemaVersion: string): Promise<ConnectedSpace> {
    // Return existing if already connected
    if (this.#personalStream) {
      return this.#personalStream;
    }

    const recordConfig = {
      collection: this.#config.spaceNsid,
      schemaVersion,
    };

    const userDid = this.agent.assertDid as UserDid;

    let attempts = 0;
    let errors: any[] = [];
    let space: ConnectedSpace | null = null;

    while (!space) {
      if (attempts > 2) throw errors;
      attempts++;
      try {
        const existingStreamDid = await getPersonalStreamId(
          this.agent,
          recordConfig,
        );
        if (!existingStreamDid) {
          throw { error: "RecordNotFound" };
        }
        console.debug("Got streamId, connecting...", {
          streamId: existingStreamDid,
        });
        space = await ConnectedSpace.connect({
          client: this,
          streamDid: existingStreamDid,
          module: modules.personal,
        });
        console.debug("Connected to personal stream");
      } catch (e) {
        if ((e as any).error === "RecordNotFound") {
          console.info(
            "Could not find existing stream ID on PDS. Creating new stream!",
          );

          // create a new stream on leaf server (this also subscribes)
          space = await ConnectedSpace.create(
            {
              client: this,
              module: modules.personal,
            },
            UserDid.assert(this.agent.assertDid),
          );

          console.debug("Putting record to PDS");

          // put the stream ID in a record
          try {
            await savePersonalStreamId(
              this.agent,
              space.streamDid,
              recordConfig,
            );
          } catch (saveError) {
            errors.push(
              new Error("Could not create PDS record for personal stream", {
                cause: saveError,
              }),
            );
          }
        } else if ((e as Error).message?.includes("Stream does not exist")) {
          console.warn("Stream does not exist");
          errors.push(e);
        } else {
          if (e instanceof Error) console.error(e);
          console.error("Error while fetching personal stream record:", e);
          errors.push(e);
        }
      }
    }

    this.#personalStream = space;

    return space;
  }

  /**
   * Join a space by sending events to both personal stream and the target space.
   *
   * @param spaceId - The stream DID of the space to join
   * @param spaceModule - Module definition for the space
   * @returns The connected space
   * @throws If personal stream is not connected
   */
  async joinSpace(
    spaceId: StreamDid,
    spaceModule: ModuleWithCid,
  ): Promise<ConnectedSpace> {
    if (!this.#personalStream) {
      throw new Error(
        "Personal stream not connected. Call connectPersonalStream() first.",
      );
    }

    // Send PersonalJoinSpace event to personal stream
    await this.#personalStream.sendEvent({
      id: newUlid(),
      $type: "space.roomy.space.personal.joinSpace.v0",
      spaceDid: spaceId,
    });

    // Connect to the target space
    const space = await ConnectedSpace.connect({
      client: this,
      streamDid: spaceId,
      module: spaceModule,
    });

    // Send JoinSpace event to the target space
    await space.sendEvent({
      id: newUlid(),
      $type: "space.roomy.space.joinSpace.v0",
    });

    return space;
  }

  /**
   * Parse whether an identifier is a DID or handle.
   */
  #parseIdType(value: string): "did" | "handle" {
    const didParsed = Did(value);
    if (!(didParsed instanceof type.errors)) return "did";
    const handleParsed = Handle(value);
    if (!(handleParsed instanceof type.errors)) return "handle";
    throw new Error(`Invalid identifier: ${value}`);
  }
}
