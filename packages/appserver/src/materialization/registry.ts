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
import type { InvalidationRouter } from "../invalidation/types.ts";
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

/**
 * Process-wide invalidation router. Set once at startup via
 * `setInvalidationRouter()`. Forwarded to every SpaceMaterializer
 * created by the registry.
 */
let globalInvalidationRouter: InvalidationRouter | undefined;

/**
 * Set the process-wide invalidation router. Called once from `index.ts`
 * at startup. All subsequently created SpaceMaterializers will forward
 * live events to this router.
 */
export function setInvalidationRouter(router: InvalidationRouter): void {
  globalInvalidationRouter = router;
}

export interface GetOrCreateOpts {
  /** Override the DB handle (tests). Defaults to the process-wide singleton. */
  db?: Database;
  /** Override the space resolver (tests). Defaults to the live service client. */
  getConnectedSpace?: (streamDid: StreamDid) => Promise<ConnectedSpaceLike>;
  /** Override the profile fetcher (tests). Defaults to the service client's `getProfiles`. */
  getProfiles?: GetProfilesFn;
  /**
   * Override the invalidation router. If omitted, falls back to the
   * process-wide router set via `setInvalidationRouter()`.
   * Pass `null` explicitly to disable for a specific materializer (tests).
   */
  invalidationRouter?: InvalidationRouter | null;
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

  // Resolve invalidation router: explicit opt > process-wide > undefined.
  const invalidationRouter =
    opts.invalidationRouter === null
      ? undefined
      : (opts.invalidationRouter ?? globalInvalidationRouter);

  const promise = SpaceMaterializer.start({
    streamDid,
    db: opts.db ?? openDb(),
    getConnectedSpace: opts.getConnectedSpace ?? defaultGetConnectedSpace,
    getProfiles: opts.getProfiles ?? defaultGetProfiles,
    invalidationRouter,
  }).catch((err) => {
    materializers.delete(streamDid);
    throw err;
  });

  materializers.set(streamDid, promise);
  return promise;
}

/** Clear cached materializers and the global router. Tests only. */
export function _resetMaterializerRegistry(): void {
  materializers.clear();
  globalInvalidationRouter = undefined;
}
