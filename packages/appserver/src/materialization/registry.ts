/**
 * Lazy per-stream materializer registry.
 *
 * On first request for a streamDid we open a `ConnectedSpace`, instantiate a
 * `SpaceMaterializer`, and cache the in-flight promise so concurrent callers
 * share the same instance. A failed startup clears the cache so the next
 * caller can retry.
 */

import { Database } from "bun:sqlite";
import { type StreamDid, type UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import {
  getConnectedSpace as defaultGetConnectedSpace,
  getServiceClient,
} from "../serviceClient.ts";
import {
  SpaceMaterializer,
  type ConnectedSpaceLike,
} from "./SpaceMaterializer.ts";
import type { GetProfilesFn } from "./profiles.ts";

const materializers = new Map<StreamDid, Promise<SpaceMaterializer>>();

export interface GetOrCreateOpts {
  /** Override the DB handle (tests). Defaults to the process-wide singleton. */
  db?: Database;
  /** Override the space resolver (tests). Defaults to the live service client. */
  getConnectedSpace?: (streamDid: StreamDid) => Promise<ConnectedSpaceLike>;
  /** Override the profile fetcher (tests). Defaults to the service client's `getProfiles`. */
  getProfiles?: GetProfilesFn;
}

/**
 * Default profile fetcher: lazily resolves the `RoomyServiceClient` on first
 * call and reuses it thereafter. Lazy resolution means the appserver can boot
 * without Leaf reachable, matching the `serviceClient` singleton's behaviour.
 */
const defaultGetProfiles: GetProfilesFn = async (dids: UserDid[]) => {
  const client = await getServiceClient();
  return client.getProfiles(dids);
};

export function getOrCreateMaterializer(
  streamDid: StreamDid,
  opts: GetOrCreateOpts = {},
): Promise<SpaceMaterializer> {
  const existing = materializers.get(streamDid);
  if (existing) return existing;

  const promise = SpaceMaterializer.start({
    streamDid,
    db: opts.db ?? openDb(),
    getConnectedSpace: opts.getConnectedSpace ?? defaultGetConnectedSpace,
    getProfiles: opts.getProfiles ?? defaultGetProfiles,
  }).catch((err) => {
    materializers.delete(streamDid);
    throw err;
  });

  materializers.set(streamDid, promise);
  return promise;
}

/** Clear cached materializers. Tests only. */
export function _resetMaterializerRegistry(): void {
  materializers.clear();
}
