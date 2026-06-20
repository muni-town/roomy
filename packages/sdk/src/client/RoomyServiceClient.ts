/**
 * RoomyServiceClient - Service-to-service client for Roomy infrastructure.
 *
 * Authenticates via a static token (`UNSAFE_AUTH_TOKEN`) configured on the
 * Leaf server, which makes the connection identify as the Leaf server's own
 * DID. Combined with adding that DID to the Leaf server's `MODULE_ADMINS`
 * (and the per-space module's admin allowlist), this gives the service
 * admin-level access in any space.
 *
 * Unlike `RoomyClient`, this client has no `Agent` and therefore exposes
 * neither PDS operations nor user-flow helpers. It only provides the
 * Leaf-side surface inherited from `RoomyClientBase`.
 */

import type { AdminListStreamsItem, LeafClient } from "@muni-town/leaf-client";
import { AtpAgent } from "@atproto/api";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import { Deferred } from "../utils/Deferred";
import { createLeafClient, type LeafConfig } from "../leaf";
import { withTimeoutWarning } from "../utils/timeout";
import { RoomyClientBase } from "./RoomyClientBase";
import { ConnectedSpace } from "../connection/ConnectedSpace";
import type { ModuleWithCid } from "../modules";
import type { StreamDid, UserDid } from "../schema";

/** Default unauthenticated bsky appview endpoint for read-only profile queries. */
export const DEFAULT_BSKY_APPVIEW_URL = "https://api.bsky.app";

/** Bsky's bulk profile API caps actors at 25 per request. */
const GET_PROFILES_CHUNK_SIZE = 25;

export interface RoomyServiceClientConfig extends LeafConfig {
  /**
   * Static token for authenticating to the Leaf server. Must match the
   * `UNSAFE_AUTH_TOKEN` configured on the Leaf server. The connection will
   * be authenticated as the server's own DID.
   */
  unsafeAuthToken: string;
  /** PLC directory URL for resolving DIDs. Defaults to https://plc.directory */
  plcDirectory?: string;
  /**
   * Public bsky appview URL for unauthenticated profile reads. Defaults to
   * `https://api.bsky.app`. The appview is the canonical source for bulk
   * `app.bsky.actor.getProfiles` queries and does not require auth.
   */
  bskyAppviewUrl?: string;
}

export interface RoomyServiceClientEvents {
  /** Called when Leaf connection is established */
  onConnect?: () => void;
  /** Called when Leaf connection is lost */
  onDisconnect?: () => void;
}

export class RoomyServiceClient extends RoomyClientBase {
  /** DID this client is authenticated as (the Leaf server's own DID). */
  readonly serviceDid: string;

  /**
   * Unauthenticated AtpAgent pointed at the public bsky appview, used for
   * read-only queries like bulk profile fetches. We cache one agent per
   * client; the appview rate-limits per source IP, not per agent.
   */
  private readonly bskyAgent: AtpAgent;

  private constructor(
    leaf: LeafClient,
    config: RoomyServiceClientConfig,
    serviceDid: string,
  ) {
    super({ leaf, plcDirectory: config.plcDirectory });
    this.serviceDid = serviceDid;
    this.bskyAgent = new AtpAgent({
      service: config.bskyAppviewUrl ?? DEFAULT_BSKY_APPVIEW_URL,
    });
  }

  /**
   * Bulk-fetch public profiles via the unauthenticated bsky appview.
   *
   * Splits requests into chunks of 25 (the API limit). DIDs that the appview
   * cannot resolve are silently dropped from the result; the caller should
   * tolerate a return list shorter than its input.
   *
   * Mirrors the frontend `peer.getProfiles(dids)` shape so callers can move
   * between the two without reshaping records.
   */
  async getProfiles(dids: UserDid[]): Promise<ProfileViewDetailed[]> {
    if (dids.length === 0) return [];

    const chunks: UserDid[][] = [];
    for (let i = 0; i < dids.length; i += GET_PROFILES_CHUNK_SIZE) {
      chunks.push(dids.slice(i, i + GET_PROFILES_CHUNK_SIZE));
    }

    const results = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const resp = await this.bskyAgent.getProfiles({ actors: chunk });
          return resp.data.profiles;
        } catch (err) {
          // The appview returns 400 for batches containing any unresolvable
          // DID. We don't want one bad DID to poison a whole space's worth
          // of profile fetches, so log and return an empty chunk; callers
          // will retry next batch if a DID becomes resolvable later.
          console.warn(
            `RoomyServiceClient.getProfiles: chunk failed (${chunk.length} dids): ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }
      }),
    );

    return results.flat();
  }

  /**
   * Create a RoomyServiceClient and wait for Leaf authentication.
   * Returns only when the client is fully ready to use.
   *
   * The resolved `serviceDid` is the DID the Leaf server reports back on
   * authentication — i.e. its own DID.
   */
  static async create(
    config: RoomyServiceClientConfig,
    events?: RoomyServiceClientEvents,
  ): Promise<RoomyServiceClient> {
    const leaf = createLeafClient(
      { type: "static", token: config.unsafeAuthToken },
      { leafUrl: config.leafUrl, leafDid: config.leafDid },
    );

    const authenticated = new Deferred<string>();
    let settled = false;

    leaf.on("connect", () => {
      console.info("Leaf: connected (service)");
      events?.onConnect?.();
    });

    leaf.on("disconnect", () => {
      console.info("Leaf: disconnected (service)");
      events?.onDisconnect?.();
      if (!settled) {
        settled = true;
        authenticated.reject(
          new Error("Leaf disconnected before authentication completed"),
        );
      }
    });

    leaf.on("error", (error) => {
      console.error("Leaf: error", error);
      if (!settled) {
        settled = true;
        authenticated.reject(new Error(`Leaf authentication error: ${error}`));
      }
    });

    leaf.on("authenticated", (did) => {
      console.info("Leaf: authenticated as", { did });
      // The Leaf server returns its own DID for unsafe-token auth. We assert
      // it's a string here — if the server omits it, treat as a hard error.
      if (typeof did !== "string") {
        if (!settled) {
          settled = true;
          authenticated.reject(
            new Error("Leaf server did not return a DID on authentication"),
          );
        }
        return;
      }
      if (!settled) {
        settled = true;
        authenticated.resolve(did);
      }
    });

    const serviceDid = await withTimeoutWarning(
      authenticated.promise,
      "RoomyServiceClient.create: waiting for Leaf authentication",
    ).catch((err) => {
      // Clean up Leaf connection on failure so the caller can retry with
      // a fresh client (e.g. serviceClient.ts resets clientPromise = null).
      leaf.disconnect();
      throw err;
    });

    return new RoomyServiceClient(leaf, config, serviceDid);
  }

  /**
   * Connect to an existing space stream. Module CID mismatches will be
   * reconciled by uploading and updating the module — which only succeeds if
   * this client's DID is permitted to update modules on that stream (i.e.
   * listed in the Leaf server's `MODULE_ADMINS` or in the stream's owners).
   */
  async connectSpace(
    streamDid: StreamDid,
    module: ModuleWithCid,
    subscriptionBatchLimit?: number,
  ): Promise<ConnectedSpace> {
    return ConnectedSpace.connect({
      client: this,
      streamDid,
      module,
      subscriptionBatchLimit,
    });
  }

  /**
   * Create a new space stream and connect to it. The provided `adminDid` is
   * granted admin via the standard `space.roomy.space.addAdmin.v0` event.
   */
  async createSpace(
    module: ModuleWithCid,
    adminDid: UserDid,
  ): Promise<ConnectedSpace> {
    return ConnectedSpace.create({ client: this, module }, adminDid);
  }

  /**
   * List all streams on the Leaf server.
   *
   * Requires admin-level access on the Leaf server (the connection must be
   * authenticated with a token that has admin privileges, e.g.
   * `UNSAFE_AUTH_TOKEN` with the server's own DID listed in
   * `MODULE_ADMINS`).
   */
  async listStreams(): Promise<AdminListStreamsItem[]> {
    return this.leaf.listStreams();
  }
}
