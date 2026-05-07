/**
 * Lazy per-stream materializer registry.
 *
 * On first request for a streamDid we open a `ConnectedSpace`, instantiate a
 * `SpaceMaterializer`, and cache the in-flight promise so concurrent callers
 * share the same instance. A failed startup clears the cache so the next
 * caller can retry.
 */

import { Database } from "bun:sqlite";
import { type StreamDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { getConnectedSpace as defaultGetConnectedSpace } from "../serviceClient.ts";
import {
  SpaceMaterializer,
  type ConnectedSpaceLike,
} from "./SpaceMaterializer.ts";

const materializers = new Map<StreamDid, Promise<SpaceMaterializer>>();

export interface GetOrCreateOpts {
  /** Override the DB handle (tests). Defaults to the process-wide singleton. */
  db?: Database;
  /** Override the space resolver (tests). Defaults to the live service client. */
  getConnectedSpace?: (streamDid: StreamDid) => Promise<ConnectedSpaceLike>;
}

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
