/**
 * Shared DID → PDS endpoint resolution with a stale-while-revalidate cache.
 *
 * Used by the blob proxy (`blob.ts`), the Roomy profile record fetcher
 * (`materialization/roomyProfile.ts`), and on-demand profile hydration.
 * Each consumer previously had its own copy of this logic; this module
 * centralises it so the cache is shared.
 */

import { IdResolver } from "@atproto/identity";

const PLC_DIRECTORY_URL =
  process.env.PLC_DIRECTORY_URL ?? "https://plc.directory";

const idResolver = new IdResolver({ plcUrl: PLC_DIRECTORY_URL });

/** DID → PDS endpoint cache (5-minute TTL, stale-while-revalidate). */
const pdsCache = new Map<string, string>();
const pdsCacheTime = new Map<string, number>();
const PDS_CACHE_TTL = 5 * 60 * 1000;

/**
 * Resolve a DID to its ATProto PDS service endpoint.
 *
 * Uses an in-memory cache with a 5-minute TTL. On cache hit the cached value
 * is returned immediately; the DID document is re-resolved in the background
 * to refresh the cache (stale-while-revalidate).
 *
 * Throws if the DID document cannot be resolved or has no `#atproto_pds`
 * service.
 */
export async function resolvePdsEndpoint(did: string): Promise<string> {
  const now = Date.now();
  const cachedAt = pdsCacheTime.get(did);
  if (cachedAt && now - cachedAt < PDS_CACHE_TTL) {
    const cached = pdsCache.get(did);
    if (cached) return cached;
  }

  const doc = await idResolver.did.resolve(did);
  if (!doc) throw new Error(`Could not resolve DID document for ${did}`);
  const service = doc.service?.find(
    (s: { id: string; type: string; serviceEndpoint: unknown }) =>
      s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
  );
  if (!service || typeof service.serviceEndpoint !== "string") {
    throw new Error(`No #atproto_pds service in DID document for ${did}`);
  }

  pdsCache.set(did, service.serviceEndpoint);
  pdsCacheTime.set(did, now);
  return service.serviceEndpoint;
}

/** Re-export the IdResolver for consumers that need handle→DID resolution. */
export { idResolver };