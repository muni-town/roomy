/**
 * Shared DID-document resolution with a process-wide cache.
 *
 * One cached `IdResolver` backs every consumer — the blob proxy (`blob.ts`),
 * the Roomy profile fetcher (`materialization/roomyProfile.ts`), on-demand
 * profile hydration, handle→DID resolution and session-JWT verification
 * (`xrpc/auth.ts`) — so a DID document is fetched once per cache window per
 * process instead of once per call site per request.
 *
 * This cache is the only back-pressure a `did:web` host has: it serves its
 * document as a plain HTTPS resource with nothing in front of it.
 */

import {
  IdResolver,
  MemoryCache,
  type CacheResult,
  type DidDocument,
} from "@atproto/identity";

const PLC_DIRECTORY_URL =
  process.env.PLC_DIRECTORY_URL ?? "https://plc.directory";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Read a positive millisecond duration from the environment. */
function durationFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `[identity] ignoring ${name}=${raw}: expected a positive number of milliseconds`,
    );
    return fallback;
  }
  return value;
}

/**
 * How long a cached document may be served before the next resolution
 * revalidates it, and how long it may be served at all.
 *
 * Defaults match `@atproto/identity`'s own `MemoryCache`: an hour before
 * revalidating, a day before the entry is dropped. A `did:web` host therefore
 * sees at most one document fetch per DID per hour however much traffic
 * resolves that DID.
 *
 * Staleness bounds: a rotated document is picked up by the next resolution to
 * happen after `DID_CACHE_STALE_MS` (an hour), and a document is never served
 * beyond `DID_CACHE_MAX_MS` (a day) — at that point resolution is a blocking
 * fetch again and fails loudly if the host is unreachable. Session-JWT
 * verification is not bound by either: `verifyJwt` retries with
 * `forceRefresh` when a signature does not match the cached key, so a rotated
 * signing key is honoured on the first token that needs it.
 */
const DID_CACHE_STALE_MS = durationFromEnv("DID_CACHE_STALE_MS", HOUR_MS);
const DID_CACHE_MAX_MS = durationFromEnv("DID_CACHE_MAX_MS", 24 * HOUR_MS);

/**
 * `MemoryCache` that keeps serving the last known document when a
 * revalidation fails, and collapses concurrent revalidations of one DID into a
 * single outbound fetch.
 *
 * A plain `MemoryCache` propagates a failed revalidation to the caller and
 * retries it on the next request, so a `did:web` host that is slow or briefly
 * down turns every request into a fetch attempt that also fails the caller.
 * Serving the stale document keeps that invisible to callers (there is a
 * document, just an older one), and the attempt throttle bounds revalidation
 * to one fetch per `staleTTL` per DID. The age bound is unchanged: `maxTTL`
 * still expires the entry, after which resolution must fetch.
 */
export class ResilientDidCache extends MemoryCache {
  /** Revalidations in flight, per DID — concurrent callers share one fetch. */
  readonly #refreshing = new Map<string, Promise<void>>();
  /** Last revalidation attempt per DID, successful or not. */
  readonly #attemptedAt = new Map<string, number>();

  override async refreshCache(
    did: string,
    getDoc: () => Promise<DidDocument | null>,
    _prev?: CacheResult,
  ): Promise<void> {
    const inFlight = this.#refreshing.get(did);
    if (inFlight) return inFlight;

    // A failed revalidation leaves the entry's `updatedAt` alone, so
    // `checkCache` keeps reporting the document stale. Throttling on the
    // attempt instead is what stops a request loop behind an unreachable host
    // from becoming a fetch loop.
    const attemptedAt = this.#attemptedAt.get(did);
    if (attemptedAt !== undefined && Date.now() - attemptedAt < this.staleTTL) {
      return;
    }

    const attempt = (async () => {
      this.#attemptedAt.set(did, Date.now());
      try {
        const doc = await getDoc();
        if (doc) await super.cacheDid(did, doc);
      } catch {
        // Keep the last known good document; `maxTTL` still bounds its age.
      }
    })().finally(() => {
      this.#refreshing.delete(did);
    });

    this.#refreshing.set(did, attempt);
    return attempt;
  }

  override async clearEntry(did: string): Promise<void> {
    this.#attemptedAt.delete(did);
    await super.clearEntry(did);
  }

  override async clear(): Promise<void> {
    this.#attemptedAt.clear();
    this.#refreshing.clear();
    await super.clear();
  }
}

/** The appserver's one DID resolver; every DID-document fetch goes through it. */
const idResolver = new IdResolver({
  plcUrl: PLC_DIRECTORY_URL,
  didCache: new ResilientDidCache(DID_CACHE_STALE_MS, DID_CACHE_MAX_MS),
});

/**
 * Resolve a DID to its ATProto PDS service endpoint.
 *
 * Served from the shared DID-document cache (see the module docstring): a
 * `did:web` host sees at most one document fetch per DID per
 * `DID_CACHE_STALE_MS`, and a failed revalidation keeps serving the last known
 * document rather than failing the caller.
 *
 * Throws if the DID document cannot be resolved or has no `#atproto_pds`
 * service.
 */
export async function resolvePdsEndpoint(did: string): Promise<string> {
  const doc = await idResolver.did.resolve(did);
  if (!doc) throw new Error(`Could not resolve DID document for ${did}`);
  const service = doc.service?.find(
    (s: { id: string; type: string; serviceEndpoint: unknown }) =>
      s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
  );
  if (!service || typeof service.serviceEndpoint !== "string") {
    throw new Error(`No #atproto_pds service in DID document for ${did}`);
  }
  return service.serviceEndpoint;
}

/** Re-export the IdResolver for consumers that need handle→DID resolution. */
export { idResolver };
