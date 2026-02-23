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
  createProfileSpaceRecord,
  removeProfileSpaceRecord,
  getPersonalStreamId,
  savePersonalStreamId,
} from "../atproto";
import { ConnectedSpace } from "../connection/ConnectedSpace";
import { modules, type ModuleWithCid } from "../modules";
import { withTimeoutWarning } from "../utils/timeout";

const DEFAULT_PLC_DIRECTORY = "https://plc.directory";

export interface RoomyClientConfig extends LeafConfig {
  agent: Agent;
  /** Collection for personal space record, e.g., "space.roomy.space.personal.dev" */
  spaceNsid: string;
  /** Collection for space handle records, e.g., "space.roomy.profileSpace" */
  profileSpaceNsid: string;
  /** PLC directory URL for resolving DIDs. Defaults to https://plc.directory */
  plcDirectory?: string;
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
  readonly plcDirectory: string;

  // Caches
  readonly #profileCache = new Map<string, ProfileResponse>();
  readonly #profileSpaceCache = new Map<string, StreamDid | undefined>();

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
    this.plcDirectory = config.plcDirectory ?? DEFAULT_PLC_DIRECTORY;
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
    await withTimeoutWarning(
      authenticated.promise,
      "RoomyClient.create: waiting for Leaf authentication",
    );

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
    } catch (_e) {
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
    const idType = this.#parseIdType(spaceIdOrHandle);

    if ("handle" in idType) {
      // There are two ways to resolve the handle to the space:
      // 1. By using the `_leaf.example.handle` TXT record
      // 2. By using the `space.roomy.profileSpace` `self` record on the PDS associated to the
      //    handle.

      // Resolve using the leaf txt record and the profile space at the same time
      const leafResolve = resolveLeafDidFromHandle(spaceIdOrHandle).catch(
        (_e) => undefined,
      );
      const profileSpaceResolve = this.resolveProfileSpaceFromUserHandle(
        spaceIdOrHandle,
      ).catch((_e) => undefined);
      const [leafResult, profileResult] = await Promise.all([
        leafResolve,
        profileSpaceResolve,
      ]);

      // Make sure one of the resolvers succeeded
      const spaceDid = leafResult || profileResult;
      if (!spaceDid) {
        throw new Error(
          `Could not resolve space ID from handle: ${spaceIdOrHandle}`,
        );
      }

      return { spaceDid, handle: idType.handle };
    }

    return { spaceDid: spaceIdOrHandle as StreamDid };
  }

  /**
   * Resolve a handle for a space, verifying that the handle also points to this space.
   *
   * @param verify If this is set to false it will just do the handle lookup without checking that
   * the handle also resolves to the space's DID.
   */
  async resolveHandleFromSpaceId(
    spaceDid: StreamDid,
    verify = true,
  ): Promise<Handle | undefined> {
    try {
      // There are two ways that we can resolve the handle from the space ID:
      // 1. By looking at the DID document's alsoKnownAs fields and looking for a leaf:// link.
      // 2. By running a `stream_info` query against the Roomy space's stream and getting it's
      //    `handleProvider`.

      // Try both methods for resolving the handle
      let resolveLeaf = this.resolveHandleFromLeafDid(spaceDid);
      let resolveSpace = this.resolveHandleFromSpaceHandleProvider(spaceDid);
      const [resultLeaf, resultSpace] = await Promise.all([
        resolveLeaf,
        resolveSpace,
      ]);
      const handle = resultLeaf || resultSpace;

      if (verify && handle) {
        const { spaceDid: resolvedSpaceDid } =
          await this.resolveSpaceIdFromDidOrHandle(handle);

        if (spaceDid == resolvedSpaceDid) {
          return handle;
        } else {
          console.warn(
            `Space with DID ${spaceDid} resolved to handle\
            ${handle}, but handle resolved to different DID: ${resolvedSpaceDid}`,
          );
          return undefined;
        }
      } else {
        return handle;
      }
    } catch (_e) {
      // Errors are fine, the handle just might not exist, so ignore them.
    }
    return undefined;
  }

  async resolveHandleFromSpaceHandleProvider(
    spaceDid: StreamDid,
  ): Promise<Handle | undefined> {
    const spaceInfo = await this.getSpaceInfo(spaceDid);
    if (!spaceInfo) return undefined;
    const { handleProvider } = spaceInfo;
    if (!handleProvider) return undefined;

    const profile = await this.getProfile(handleProvider);
    if (!profile) return undefined;

    return profile.handle as Handle;
  }

  /**
   * Get space info from the Leaf server.
   */
  async getSpaceInfo(
    streamDid: StreamDid,
  ): Promise<
    { name?: string; avatar?: string; handleProvider?: UserDid } | undefined
  > {
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
      const handleProvider =
        row.handle_provider?.$type === "muni.town.sqliteValue.text"
          ? row.handle_provider.value
          : undefined;

      return {
        name,
        avatar,
        handleProvider: handleProvider
          ? UserDid.assert(handleProvider)
          : undefined,
      };
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
            console.debug(
              "Saved stream record to PDS with NSID:",
              recordConfig.collection,
            );
          } catch (saveError) {
            // I'm not sure if this should throw. I was having an issue where it was failing silently...
            throw new Error("Could not create PDS record for personal stream");
            // errors.push(
            //   new Error("Could not create PDS record for personal stream", {
            //     cause: saveError,
            //   }),
            // );
          }
        } else if ((e as Error).message?.includes("Stream does not exist")) {
          // Stream record exists on PDS but stream doesn't exist on Leaf server.
          // This can happen if the stream was deleted or the Leaf server was reset.
          // Don't auto-recreate to avoid data loss. User should manually verify and delete the record if needed.
          console.error(
            "Stream record exists on PDS but stream doesn't exist on Leaf server. " +
              "This may indicate data inconsistency. Manual recovery may be needed. " +
              "To fix, you may need to delete the stale PDS record and let it recreate.",
            { error: (e as Error).message },
          );
          errors.push(e);
          // Don't retry - this won't fix itself
          break;
        } else {
          if (e instanceof Error) console.error(e);
          console.error("Error while fetching personal stream record:", e);
          errors.push(e);
        }
      }
    }

    if (!space) {
      throw new Error(
        `Failed to connect to personal stream after ${attempts} attempts`,
        { cause: errors },
      );
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
   * Set the leaf handle for a stream. This updates the DID document with a `leaf://example.handle`
   * alias, or removes an existing alias if the handle is `null`.
   */
  setHandle(streamDid: StreamDid, handle: string | null): Promise<void> {
    return this.leaf.setHandle(streamDid, handle);
  }

  /**
   * Parse whether an identifier is a DID or handle.
   */
  #parseIdType(value: string): { did: Did } | { handle: Handle } {
    const didParsed = Did(value);
    if (!(didParsed instanceof type.errors)) return { did: didParsed };
    const handleParsed = Handle(value);
    if (!(handleParsed instanceof type.errors)) return { handle: handleParsed };
    throw new Error(`Invalid identifier: ${value}`);
  }

  /**
   * Resolves the Leaf handle from a stream's DID document.
   */
  async resolveHandleFromLeafDid(
    streamDid: StreamDid,
  ): Promise<Handle | undefined> {
    const resp: { alsoKnownAs: string[] } = await (
      await fetch(`${this.plcDirectory}/${streamDid}`)
    ).json();

    const handle = resp.alsoKnownAs
      .filter((x) => x.startsWith("leaf://"))[0]
      ?.split("leaf://")[1] as Handle | undefined;

    return handle;
  }
}

/**
 * Resolves the Leaf stream DID for a handle using DNS TXT records.
 */
export async function resolveLeafDidFromHandle(
  handle: Handle,
): Promise<StreamDid | undefined> {
  const resp = await fetch(
    `https://resolver.roomy.chat/xrpc/town.muni.leaf.resolveHandle?handle=${encodeURIComponent(handle)}`,
    {
      headers: [["accept", "application/json"]],
    },
  );
  if (!resp.ok) {
    throw new Error(
      `Error resolving leaf handle to DID (${resp.status}: ${resp.statusText}): ${await resp.text()}`,
    );
  }
  const json = await resp.json();
  const did = json.did;
  return StreamDid.assert(did);
}
