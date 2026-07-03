/**
 * RoomyClient - High-level client for interacting with Roomy infrastructure.
 *
 * Wraps ATProto Agent, providing:
 * - Cached profile lookups
 * - Cached handle resolution
 * - Cached stream handle record lookups
 * - Space resolution from handles or DIDs
 * - PDS operations (blob uploads, records)
 */

import type { Agent } from "@atproto/api";
import { Did, Handle, UserDid, StreamDid, type } from "../schema";
import {
  getProfile,
  type Profile,
  uploadBlob,
  createProfileSpaceRecord,
  removeProfileSpaceRecord,
} from "../atproto";

export interface RoomyClientConfig {
  agent: Agent;
  /** Collection for personal space record, e.g., "space.roomy.space.personal.dev" */
  spaceNsid: string;
  /** Collection for space handle records, e.g., "space.roomy.profileSpace" */
  profileSpaceNsid: string;
  /** PLC directory URL for resolving DIDs. Defaults to https://plc.directory */
  plcDirectory?: string;
}

export interface RoomyClientEvents {}

interface ProfileResponse {
  success: boolean;
  data: {
    did: string;
    handle: string;
    displayName?: string;
    avatar?: string;
    description?: string;
  };
}


export class RoomyClient {
  readonly agent: Agent;
  readonly #config: RoomyClientConfig;

  // Caches
  readonly #profileCache = new Map<string, ProfileResponse>();
  readonly #profileSpaceCache = new Map<string, StreamDid | undefined>();

  constructor(config: RoomyClientConfig) {
    this.agent = config.agent;
    this.#config = config;
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

    const resp = await this.agent.getProfile(
      { actor },
      {
        headers: {
          "atproto-proxy": `did:web:api.bsky.app#bsky_appview`,
        },
      },
    );
    this.#profileCache.set(actor, resp as ProfileResponse);
    return resp as ProfileResponse;
  }

  /**
   * Resolve a profile handle to a DID, caching to reduce extraneous profile lookups.
   */
  async resolveUserDidFromHandle(handle: Handle): Promise<UserDid> {
    const profile = await this.getProfileCached(handle);
    return profile.data.did as UserDid;
  }

  /**
   * Resolve the profile space for the given handle.
   *
   * This will try and fetch, for example, the `space.roomy.profileSpace` record from the PDS of the
   * provided DID to see which Roomy space is associated to the profile.
   */
  async resolveProfileSpaceFromUserHandle(handle: Handle) {
    const userDid = await this.resolveUserDidFromHandle(handle);
    return this.resolveProfileSpaceFromUserDid(userDid);
  }

  /**
   * Resolve the profile space for the provided DID.
   *
   * This will try and fetch, for example, the `space.roomy.profileSpace` record from the PDS of the
   * provided DID to see which Roomy space is associated to the profile.
   */
  async resolveProfileSpaceFromUserDid(
    userDid: UserDid,
  ): Promise<StreamDid | undefined> {
    const cached = this.#profileSpaceCache.get(userDid);
    if (cached !== undefined) return cached;

    try {
      const resp = await this.agent.com.atproto.repo.getRecord(
        {
          // The specific NSID is configurable for different environments such as dev, next, etc.
          collection: this.#config.profileSpaceNsid,
          repo: userDid,
          rkey: "self",
        },
        {
          // We have to proxy through the PDS that is actually hosting the DID's repo. This is a very
          // easy thing to miss.
          headers: {
            "atproto-proxy": `${userDid}#atproto_pds`,
          },
        },
      );

      // Return if ID not found
      if (!resp.data.value?.id) return;

      // Make sure the ID is a valid DID
      const spaceId = StreamDid(resp.data.value.id);

      if (spaceId instanceof type.errors) {
        console.warn(
          `Could not parse stream DID ( ${resp.data.value.id} ) when \
          trying to resolve profileSpace for ${userDid}`,
        );
        return undefined;
      }

      this.#profileSpaceCache.set(userDid, spaceId);
      return spaceId;
    } catch {
      // If we can't fetch the record, then there's no space to resolve to.
      return undefined;
    }
  }

  /**
   * Set the ID of the space associated to the authenticated user's profile.
   *
   * This allows the space to use the authenticated user's handle.
   */
  async setProfileSpace(spaceId: StreamDid | null): Promise<void> {
    if (spaceId) {
      await createProfileSpaceRecord(this.agent, spaceId, {
        collection: this.#config.profileSpaceNsid,
      });
      // Invalidate cache for current user
      this.#profileSpaceCache.delete(this.agent.assertDid);
    } else {
      await removeProfileSpaceRecord(this.agent, {
        collection: this.#config.profileSpaceNsid,
      });
      // Invalidate cache for current user
      this.#profileSpaceCache.delete(this.agent.assertDid);
    }
  }

  /**
   * Resolve a space ID or handle to a space ID.
   * If given a handle, resolves via profile and stream handle record.
   */
  async resolveSpaceIdFromDidOrHandle(
    spaceIdOrHandle: StreamDid | Handle,
  ): Promise<{
    spaceDid: StreamDid;
    handle?: Handle;
  }> {
    const didParsed = Did(spaceIdOrHandle);
    if (!(didParsed instanceof type.errors)) {
      return { spaceDid: spaceIdOrHandle as StreamDid };
    }

    const handleParsed = Handle(spaceIdOrHandle);
    if (!(handleParsed instanceof type.errors)) {
      // Resolve using the profile space record on the PDS associated to the handle
      const spaceDid = await this.resolveProfileSpaceFromUserHandle(
        spaceIdOrHandle,
      );
      if (!spaceDid) {
        throw new Error(
          `Could not resolve space ID from handle: ${spaceIdOrHandle}`,
        );
      }

      return { spaceDid, handle: handleParsed };
    }

    throw new Error(`Invalid identifier: ${spaceIdOrHandle}`);
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
}
