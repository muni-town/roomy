/**
 * RoomyServiceClient - Service-to-service client for Roomy infrastructure.
 *
 * After Phase 4, this is a simple profile-fetching utility that queries the
 * bsky appview directly. All Leaf-related functionality has been removed.
 */

import { AtpAgent } from "@atproto/api";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import type { UserDid } from "../schema";

/** Default unauthenticated bsky appview endpoint for read-only profile queries. */
export const DEFAULT_BSKY_APPVIEW_URL = "https://api.bsky.app";

/** Bsky's bulk profile API caps actors at 25 per request. */
const GET_PROFILES_CHUNK_SIZE = 25;

export class RoomyServiceClient {
  /** DID this client is authenticated as. */
  readonly serviceDid: string;

  /**
   * Unauthenticated AtpAgent pointed at the public bsky appview, used for
   * read-only queries like bulk profile fetches.
   */
  private readonly bskyAgent: AtpAgent;

  constructor(opts: { bskyAppviewUrl?: string; serviceDid?: string }) {
    this.serviceDid = opts.serviceDid ?? "";
    this.bskyAgent = new AtpAgent({
      service: opts.bskyAppviewUrl ?? DEFAULT_BSKY_APPVIEW_URL,
    });
  }

  /**
   * Bulk-fetch public profiles via the unauthenticated bsky appview.
   *
   * Splits requests into chunks of 25 (the API limit). DIDs that the appview
   * cannot resolve are silently dropped from the result.
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
          console.warn(
            `RoomyServiceClient.getProfiles: chunk failed (${chunk.length} dids): ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }
      }),
    );

    return results.flat();
  }
}
