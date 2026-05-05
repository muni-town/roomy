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

import type { LeafClient } from "@muni-town/leaf-client";
import { Deferred } from "../utils/Deferred";
import { createLeafClient, type LeafConfig } from "../leaf";
import { withTimeoutWarning } from "../utils/timeout";
import { RoomyClientBase } from "./RoomyClientBase";
import { ConnectedSpace } from "../connection/ConnectedSpace";
import type { ModuleWithCid } from "../modules";
import type { StreamDid, UserDid } from "../schema";

export interface RoomyServiceClientConfig extends LeafConfig {
  /**
   * Static token for authenticating to the Leaf server. Must match the
   * `UNSAFE_AUTH_TOKEN` configured on the Leaf server. The connection will
   * be authenticated as the server's own DID.
   */
  unsafeAuthToken: string;
  /** PLC directory URL for resolving DIDs. Defaults to https://plc.directory */
  plcDirectory?: string;
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

  private constructor(
    leaf: LeafClient,
    config: RoomyServiceClientConfig,
    serviceDid: string,
  ) {
    super({ leaf, plcDirectory: config.plcDirectory });
    this.serviceDid = serviceDid;
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

    leaf.on("connect", () => {
      console.info("Leaf: connected (service)");
      events?.onConnect?.();
    });

    leaf.on("disconnect", () => {
      console.info("Leaf: disconnected (service)");
      events?.onDisconnect?.();
    });

    leaf.on("authenticated", (did) => {
      console.info("Leaf: authenticated as", { did });
      // The Leaf server returns its own DID for unsafe-token auth. We assert
      // it's a string here — if the server omits it, treat as a hard error.
      if (typeof did !== "string") {
        authenticated.reject(
          new Error("Leaf server did not return a DID on authentication"),
        );
        return;
      }
      authenticated.resolve(did);
    });

    const serviceDid = await withTimeoutWarning(
      authenticated.promise,
      "RoomyServiceClient.create: waiting for Leaf authentication",
    );

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
  ): Promise<ConnectedSpace> {
    return ConnectedSpace.connect({ client: this, streamDid, module });
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
}
