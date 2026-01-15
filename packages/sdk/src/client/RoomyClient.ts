/**
 * RoomyClient - High-level client for interacting with Roomy infrastructure.
 *
 * Wraps ATProto Agent and LeafClient, providing:
 * - Cached profile lookups
 * - Cached handle resolution
 * - Cached stream handle record lookups
 * - Space resolution from handles or DIDs
 * - PDS operations (blob uploads, records)
 */

import type { Agent } from "@atproto/api";
import type { LeafClient } from "@muni-town/leaf-client";
import {
  Did,
  Handle,
  UserDid,
  StreamDid,
  type,
} from "../schema";
import { createLeafClient, type LeafConfig } from "../leaf";
import {
  getProfile,
  type Profile,
  uploadBlob,
  createStreamHandleRecord,
  removeStreamHandleRecord,
} from "../atproto";

export interface RoomyClientConfig extends LeafConfig {
  agent: Agent;
  /** Collection for stream handle records, e.g., "space.roomy.space.handle.dev" */
  streamHandleNsid: string;
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

  constructor(config: RoomyClientConfig) {
    this.agent = config.agent;
    this.#config = config;
    this.leaf = createLeafClient(config.agent, {
      leafUrl: config.leafUrl,
      leafDid: config.leafDid,
    });
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
          collection: this.#config.streamHandleNsid,
          repo: did,
          rkey: "self",
        },
        {
          headers: {
            "atproto-proxy": `${did}#atproto_pds`,
          },
        }
      );

      const streamId = resp.data.value?.id
        ? StreamDid.assert(resp.data.value.id as string)
        : undefined;

      // Verify stream exists
      if (streamId) {
        const exists = await this.checkStreamExists(streamId);
        if (!exists) {
          console.warn(
            "Stream handle record points to non-existing stream, returning undefined"
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
        e
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
      collection: this.#config.streamHandleNsid,
    });
    // Invalidate cache for current user
    this.#streamHandleCache.delete(this.agent.assertDid);
  }

  /**
   * Remove the stream handle record for current user.
   */
  async removeStreamHandleRecord(): Promise<void> {
    await removeStreamHandleRecord(this.agent, {
      collection: this.#config.streamHandleNsid,
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
    handleAccountDid: UserDid
  ): Promise<Handle | undefined> {
    try {
      const profile = await this.getProfileCached(handleAccountDid);
      const handle = profile.data.handle as Handle;
      const resolved = await this.resolveSpaceId(handleAccountDid as unknown as Handle);
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
    streamDid: StreamDid
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
    opts?: { alt?: string; mimetype?: string }
  ) {
    return uploadBlob(this.agent, bytes, opts);
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
