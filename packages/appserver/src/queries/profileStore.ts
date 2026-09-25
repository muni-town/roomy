/**
 * Global profile store read path with an in-memory cache.
 *
 * Per-space DBs keep only stream-scoped profile rows (comp_user/comp_info);
 * a user's profile entity lives in their own stream, so cross-stream
 * authors/members don't resolve from the per-space DB. The authoritative
 * per-user profile lives in the global `profiles` table
 * (data/global.sqlite), written by the profile fetch path
 * (insertProfiles/insertProfilesWithExtras) and the SetUserProfile
 * materialiser.
 *
 * This module resolves profile display fields (name/handle/avatar) for a set
 * of DIDs from the global store, with a short-TTL in-memory cache so the
 * per-space read hot path (getMessages/getMembers/...) doesn't hit the
 * global DB on every message.
 *
 * **Self-healing reads.** The global `profiles` table is the authoritative
 * per-user store, but it is only populated as a side effect of event
 * materialisation and the `getProfile` handler. It can be missing a row for
 * a real user (backfill/fetch failure, a freshly-cleared store, or a user
 * seen for the first time after the backfill that materialised everyone
 * else). The profile page shows such a user because it hydrates on demand via
 * HappyView then Bluesky; a read of this store alone must not omit them.
 *
 * To make reads as reliable as the profile page, DIDs that aren't in the
 * global store are hydrated on demand (HappyView-first, Bluesky fallback) and
 * written back, so a profile never needs to already be present for the read
 * path to return it. A DID that resolves nowhere is not re-fetched on every
 * read — the hydration pipeline's negative cache (materialization/profiles.ts)
 * backs it off after the first failure.
 */

import { tryOpenGlobalDb } from "../db/db.ts";
import type { AsyncDatabase } from "../db/asyncDatabase.ts";
import { getHappyView } from "../happyview.ts";
import {
  PROFILE_REFRESH_TTL_MS,
  getProfilesRoomyFirst,
  insertProfilesWithExtras,
  isProfileFetchBackedOff,
  recordUnresolvedProfiles,
} from "../materialization/profiles.ts";
import type { UserDid } from "@roomy-space/sdk";
import { log } from "../log.ts";

export interface ProfileFields {
  name?: string;
  handle?: string;
  avatar?: string;
}

interface CacheEntry {
  name: string | null;
  handle: string | null;
  avatar: string | null;
  fetchedAt: number;
}

/**
 * How long a *resolved* profile is served from the in-memory cache. A resolved
 * row is authoritative until its TTL, so reads stay off the global DB.
 */
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, CacheEntry>();

/**
 * In-flight background hydrations, keyed by DID.
 *
 * A profile fetch is a third-party HTTP round-trip, so it must never sit
 * inside the caller's request: `room.getMessages` blocking on it would make a
 * slow HappyView or Bluesky a slow message list. No fetch runs on that path —
 * reads serve whatever the global `profiles` row already holds and the fetch
 * lands in the background for the next read.
 *
 * The map is what keeps that from multiplying the fetches: without it, N
 * concurrent readers of the same unknown author each launch their own batch.
 * With it, the second reader of a DID already in flight joins the existing
 * promise and issues nothing. The negative cache covers the sequential case (a
 * DID that resolved to nothing); this covers the concurrent one.
 */
const hydrationInflight = new Map<string, Promise<void>>();

/** Test/shutdown helper: the hydration batches currently in flight. */
export function _profileHydrationInFlight(): Promise<void>[] {
  return [...new Set(hydrationInflight.values())];
}

/**
 * Fetch profile rows for `dids` off the request path.
 *
 * Returns immediately. The results are written to the global `profiles` table
 * by the fetch pipeline, so the next read of these DIDs sees them; the
 * in-memory cache entries are dropped on completion so that next read re-reads
 * the row instead of serving the pre-fetch value for the rest of its 60 s TTL.
 *
 * DIDs already being fetched are skipped — the in-flight batch will write them.
 */
function startHydration(globalDb: AsyncDatabase, dids: string[]): void {
  const fresh = dids.filter((d) => !hydrationInflight.has(d));
  if (fresh.length === 0) return;

  const run = hydrateMissingProfiles(globalDb, fresh)
    .catch((err) => {
      // `hydrateMissingProfiles` swallows its own failures; this is the outer
      // guard so a defect in that path can never surface as an unhandled
      // rejection (the process installs a fatal handler on one).
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[profileStore] background hydration failed: ${message}`);
    })
    .finally(() => {
      for (const did of fresh) {
        hydrationInflight.delete(did);
        // The row may now hold fresher values than the copy read into the
        // cache before the fetch started. Drop it rather than leave a stale
        // positive in place until the TTL expires.
        cache.delete(did);
      }
    });

  for (const did of fresh) hydrationInflight.set(did, run);
}

/**
 * Test-only override for on-demand hydration's network fetch. When set,
 * `hydrateMissingProfiles` uses it instead of the HappyView-first / Bluesky
 * pipeline. E2E tests set a no-op stub to keep runs hermetic (no
 * api.bsky.app calls under parallel load).
 */
let testGetProfiles: ((dids: string[]) => Promise<{ did?: string }[]>) | null =
  null;

/** Set a test-only profile fetcher override (or null to clear). */
export function _setTestGetProfiles(
  fn: ((dids: string[]) => Promise<{ did?: string }[]>) | null,
): void {
  testGetProfiles = fn;
}

function entryToFields(entry: CacheEntry): ProfileFields | null {
  // `''` is not a handle: the profile write path stores it for Roomy-record
  // users (whose records carry no handle). Treat it as absent so consumers
  // fall back to name/did instead of rendering an empty `@`, and so the row is
  // eligible for handle hydration below.
  const handle = entry.handle || null;
  if (entry.name === null && handle === null && entry.avatar === null) {
    return null;
  }
  return {
    ...(entry.name != null ? { name: entry.name } : {}),
    ...(handle != null ? { handle } : {}),
    ...(entry.avatar != null ? { avatar: entry.avatar } : {}),
  };
}

/**
 * Resolve profile display fields for a set of DIDs from the global store.
 * Returns a Map keyed by DID; DIDs with no resolvable profile are absent
 * (callers fall back to whatever they already have).
 *
 * A DID that is missing, handle-less or TTL-stale has a background fetch
 * started for it — the read path self-heals instead of depending on the store
 * already being populated by event materialisation or the profile page, but
 * it does not wait for the fetch. The caller gets the pre-fetch state and the
 * next read gets whatever the fetch found.
 */
export async function resolveProfiles(
  dids: string[],
  opts: { allowNetworkFetch?: boolean } = {},
): Promise<Map<string, ProfileFields>> {
  const result = new Map<string, ProfileFields>();
  if (dids.length === 0) return result;

  const now = Date.now();
  const missing: string[] = [];
  for (const did of dids) {
    const cached = cache.get(did);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      const fields = entryToFields(cached);
      if (fields) {
        result.set(did, fields);
      } else {
        // Miss cached by the *global DB read*, not by a fetch: the row can
        // appear at any time (the profile page, materialisation), so re-check
        // the indexed global store rather than serving the miss. The backoff
        // on network fetches is the negative cache's job, not this cache's.
        missing.push(did);
      }
    } else {
      missing.push(did);
    }
  }

  if (missing.length > 0) {
    await resolveFromGlobalDb(missing, result, now, opts.allowNetworkFetch !== false);
  }

  return result;
}

/**
 * Look up a set of DIDs in the global `profiles` table, and — when
 * `allowNetworkFetch` — kick off a *background* fetch for the rows that are
 * missing, handle-less or TTL-stale.
 *
 * This function never touches the network itself. Fetching a profile is a
 * third-party HTTP round-trip to HappyView/Bluesky, and parking the caller's
 * request on it would make a message list as slow as its slowest profile
 * lookup; the fetch runs detached, and whatever it writes is visible to the
 * next read.
 *
 * `allowNetworkFetch: false` keeps the global-store read (an indexed SQLite
 * lookup) and starts nothing. Callers on the write path pass it: reading local
 * rows is free, and the write path has its own fetch site that must stay
 * ordered with the batch it is materialising.
 */
async function resolveFromGlobalDb(
  dids: string[],
  result: Map<string, ProfileFields>,
  now: number,
  allowNetworkFetch: boolean,
): Promise<void> {
  const globalDb = tryOpenGlobalDb();
  // No worker-backed global DB (e.g. a raw in-memory Database in tests) —
  // nothing to read from or hydrate into.
  if (!globalDb) return;

  const placeholders = dids.map(() => "?").join(",");
  const rows = await globalDb
    .query(
      `select did, handle, name, avatar, updated_at from profiles where did in (${placeholders})`,
    )
    .all<{
      did: string;
      handle: string | null;
      name: string | null;
      avatar: string | null;
      updated_at: number;
    }>(...dids);

  const present = new Set<string>();
  for (const row of rows) {
    present.add(row.did);
    const entry: CacheEntry = {
      name: row.name,
      handle: row.handle,
      avatar: row.avatar,
      fetchedAt: now,
    };
    cache.set(row.did, entry);
    const fields = entryToFields(entry);
    // A row with no usable field is cached as a miss — it keeps the global DB
    // re-read cheap without claiming the DID is resolved (the network backoff
    // is the negative cache's job).
    if (fields) result.set(row.did, fields);
  }
  // DIDs with no row at all are cached the same way. The cache only suppresses
  // the *global DB read*: `resolveProfiles` re-checks any entry that resolves
  // to no fields, since a row can appear at any time.
  for (const did of dids) {
    if (!present.has(did)) {
      cache.set(did, { name: null, handle: null, avatar: null, fetchedAt: now });
    }
  }

  if (!allowNetworkFetch) return;

  const notInDb = dids.filter((d) => !present.has(d));
  // Rows that exist but carry no usable handle — the `''` the profile write
  // path stores for Roomy-record users. Hydrate them too, so the row heals
  // rather than being pinned to a handle-less profile forever (the write path
  // treats `''` as absent, so a successful fetch replaces it).
  const handleless = rows.filter((r) => !r.handle).map((r) => r.did);
  // Rows older than the freshness TTL — re-fetch so a display-name/avatar
  // change on the PDS propagates to message/member lists without a visit to
  // the profile page. Mirrors `filterMissing` in materialization/profiles.ts,
  // so the write and read paths refresh a stale row on the same cadence.
  const stale = rows
    .filter((r) => now - r.updated_at >= PROFILE_REFRESH_TTL_MS)
    .map((r) => r.did);

  // Detached: mirrors the getProfile handler's pipeline (HappyView batch, then
  // Bluesky), writes back to the global store, and honours the shared negative
  // cache — so a DID that resolves nowhere is not retried here either. The
  // caller returns the pre-fetch values it already has; the client renders
  // those (name from the row, else a handle, else the DID) and the next read
  // picks up whatever the fetch found.
  startHydration(globalDb, [...new Set([...notInDb, ...handleless, ...stale])]);
}

/**
 * One profile-hydration batch for DIDs missing from the global store.
 *
 * Mirrors the `getProfile` handler: query HappyView (batched) for Roomy
 * profile records, fall back to the Bluesky appview, and write whatever is
 * found into the global `profiles` table (idempotent upsert). Failures are
 * swallowed — the DID is backed off and retried after the negative cache's TTL
 * or by the event materialisation path.
 *
 * The backoff lives in this function rather than inside the pipeline it calls,
 * so it applies identically whether the fetch is the real pipeline or a test
 * stub. `getProfilesRoomyFirst` also consults it, which is what keeps the write
 * path and the read path from retrying each other's failures.
 *
 * Callers on the read path reach this through {@link startHydration}, which
 * runs it detached and deduplicates by DID; it is awaited inline only where
 * the result is needed before continuing (nothing does today, but the function
 * itself stays awaitable so a caller that genuinely needs the rows can).
 */
async function hydrateMissingProfiles(
  globalDb: AsyncDatabase,
  dids: string[],
): Promise<void> {
  if (dids.length === 0) return;
  const fetchable = dids.filter((d) => !isProfileFetchBackedOff(d));
  if (fetchable.length === 0) return;
  try {
    if (testGetProfiles) {
      const stubbed = await testGetProfiles(fetchable);
      recordUnresolvedProfiles(
        fetchable,
        new Set(
          stubbed
            .map((p) => p.did)
            .filter((did): did is string => did !== undefined),
        ),
      );
      return;
    }
    const happyView = getHappyView();
    const { profiles, extras } = await getProfilesRoomyFirst(
      fetchable as UserDid[],
      happyView,
    );
    if (profiles.length > 0) {
      await insertProfilesWithExtras(globalDb, profiles, extras);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      `[profileStore] on-demand hydration failed for ${dids.length} DIDs: ${message}`,
    );
  }
}

/**
 * Fill in missing name/handle/avatar on a list of items from the global
 * profile store. `getDid` extracts the DID; `apply` merges resolved fields
 * into the item (global values win over the item's own, which act as a
 * fallback for users the global store doesn't know about).
 */
export async function hydrateProfiles<T>(
  items: T[],
  getDid: (item: T) => string,
  apply: (item: T, fields: ProfileFields) => void,
  opts: { allowNetworkFetch?: boolean } = {},
): Promise<void> {
  if (items.length === 0) return;
  const profiles = await resolveProfiles(items.map(getDid), opts);
  for (const item of items) {
    const p = profiles.get(getDid(item));
    if (p) apply(item, p);
  }
}

/**
 * Test helper. Clears the read cache *and* the in-flight dedup keys, so a
 * batch left running by one test cannot suppress the next test's fetch for the
 * same DID. The promises themselves keep running — they cannot be cancelled —
 * and their own `finally` still clears the cache entries they touched.
 */
export function _resetProfileStoreCache(): void {
  cache.clear();
  hydrationInflight.clear();
}
