/**
 * RoomyClientBase - shared functionality for clients of Roomy infrastructure.
 *
 * Holds the LeafClient and operations that don't require a logged-in ATProto
 * user (no `Agent` access). Both `RoomyClient` (end-user) and
 * `RoomyServiceClient` (service-to-service) extend this.
 */

import type { LeafClient } from "@muni-town/leaf-client";
import { Did, Handle, StreamDid, UserDid, type } from "../schema";

export const DEFAULT_PLC_DIRECTORY = "https://plc.directory";

export interface RoomyClientBaseConfig {
  leaf: LeafClient;
  /** PLC directory URL for resolving DIDs. Defaults to https://plc.directory */
  plcDirectory?: string;
}

export abstract class RoomyClientBase {
  readonly leaf: LeafClient;
  readonly plcDirectory: string;

  protected constructor(config: RoomyClientBaseConfig) {
    this.leaf = config.leaf;
    this.plcDirectory = config.plcDirectory ?? DEFAULT_PLC_DIRECTORY;
  }

  /**
   * Get space info from the Leaf server.
   */
  async getSpaceInfo(streamDid: StreamDid): Promise<
    | {
        name?: string;
        avatar?: string;
        handleProvider?: UserDid;
        allowPublicJoin?: boolean;
        isMember: boolean;
        isAdmin: boolean;
      }
    | undefined
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
      const allowPublicJoin =
        row.allow_public_join?.$type === "muni.town.sqliteValue.integer"
          ? row.allow_public_join.value === 1
          : undefined;
      const isMember =
        row.is_member?.$type === "muni.town.sqliteValue.integer"
          ? row.is_member.value === 1
          : false;
      const isAdmin =
        row.is_admin?.$type === "muni.town.sqliteValue.integer"
          ? row.is_admin.value === 1
          : false;

      return {
        name,
        avatar,
        handleProvider: handleProvider
          ? UserDid.assert(handleProvider)
          : undefined,
        allowPublicJoin,
        isMember,
        isAdmin,
      };
    } catch (error) {
      console.error("Failed to load space info", { streamDid, error });
      return undefined;
    }
  }

  /**
   * Set the leaf handle for a stream. This updates the DID document with a
   * `leaf://example.handle` alias, or removes an existing alias if the handle
   * is `null`.
   */
  setHandle(streamDid: StreamDid, handle: string | null): Promise<void> {
    return this.leaf.setHandle(streamDid, handle);
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

  /**
   * Parse whether an identifier is a DID or handle.
   */
  protected parseIdType(value: string): { did: Did } | { handle: Handle } {
    const didParsed = Did(value);
    if (!(didParsed instanceof type.errors)) return { did: didParsed };
    const handleParsed = Handle(value);
    if (!(handleParsed instanceof type.errors)) return { handle: handleParsed };
    throw new Error(`Invalid identifier: ${value}`);
  }
}
