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
 * else). Previously this read path silently returned a fallback (the message
 * row's own author fields) for those users — so `getMessages` could omit a
 * profile that the profile page (which hydrates on demand via HappyView then
 * Bluesky) reliably showed.
 *
 * To make reads as reliable as the profile page, DIDs that aren't in the
 * global store are hydrated on demand (HappyView-first, Bluesky fallback) and
 * written back, so a profile never needs to already be present for the read
 * path to return it. Failed/missing lookups are cached (short TTL) so a user
 * with no profile anywhere isn't re-fetched on every read.
 */

import { tryOpenGlobalDb } from "../db/db.ts";
import type { AsyncDatabase } from "../db/asyncDatabase.ts";
import { getHappyView } from "../happyview.ts";
import {
  getProfilesRoomyFirst,
  insertProfilesWithExtras,
} from "../materialization/profiles.ts";
import type { UserDid } from "@roomy-space/sdk";

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

/** How long a resolved profile (or a miss) is cached before re-querying. */
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, CacheEntry>();

/**
 * Test-only override for on-demand hydration's network fetch. When set,
 * `hydrateMissingProfiles` uses it instead of the HappyView-first / Bluesky
 * pipeline. E2E tests set a no-op stub to keep runs hermetic (no
 * api.bsky.app calls under parallel load).
 */
let testGetProfiles: ((dids: string[]) => Promise<unknown[]>) | null = null;

/** Set a test-only profile fetcher override (or null to clear). */
export function _setTestGetProfiles(
  fn: ((dids: string[]) => Promise<unknown[]>) | null,
): void {
  testGetProfiles = fn;
}

function entryToFields(entry: CacheEntry): ProfileFields | null {
  if (entry.name === null && entry.handle === null && entry.avatar === null) {
    return null;
  }
  return {
    ...(entry.name != null ? { name: entry.name } : {}),
    ...(entry.handle != null ? { handle: entry.handle } : {}),
    ...(entry.avatar != null ? { avatar: entry.avatar } : {}),
  };
}

/**
 * Resolve profile display fields for a set of DIDs from the global store.
 * Returns a Map keyed by DID; DIDs with no resolvable profile are absent
 * (callers fall back to whatever they already have).
 *
 * DIDs missing from the global store are hydrated on-demand (HappyView-first,
 * Bluesky fallback) and written back, so the read path self-heals instead of
 * depending on the store already being populated by event materialisation or
 * the profile page.
 */
export async function resolveProfiles(
  dids: string[],
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
        // Cached miss: re-check the global DB (cheap indexed lookups) in case
        // the profile was populated by another path (e.g. the profile page)
        // since we cached the miss.
        missing.push(did);
      }
    } else {
      missing.push(did);
    }
  }

  if (missing.length > 0) {
    await resolveFromGlobalDb(missing, result, now);
  }

  return result;
}

/**
 * Look up a set of DIDs in the global `profiles` table, then self-heal any
 * that are still missing via on-demand HappyView-first hydration.
 */
async function resolveFromGlobalDb(
  dids: string[],
  result: Map<string, ProfileFields>,
  now: number,
): Promise<void> {
  const globalDb = tryOpenGlobalDb();
  // No worker-backed global DB (e.g. a raw in-memory Database in tests) —
  // nothing to read from or hydrate into.
  if (!globalDb) return;

  const stillMissing: string[] = [];
  const placeholders = dids.map(() => "?").join(",");
  const rows = await globalDb
    .query(
      `select did, handle, name, avatar from profiles where did in (${placeholders})`,
    )
    .all<{
      did: string;
      handle: string | null;
      name: string | null;
      avatar: string | null;
    }>(...dids);
  for (const row of rows) {
    const entry: CacheEntry = {
      name: row.name,
      handle: row.handle,
      avatar: row.avatar,
      fetchedAt: now,
    };
    cache.set(row.did, entry);
    const fields = entryToFields(entry);
    if (fields) result.set(row.did, fields);
    else stillMissing.push(row.did);
  }

  const notInDb = dids.filter((d) => !rows.some((r) => r.did === d));
  if (notInDb.length > 0) {
    // On-demand hydration mirroring the getProfile handler: fetch Roomy
    // records from HappyView (batch) and fall back to Bluesky, then write
    // back to the global store. This is what makes reads as reliable as the
    // profile page even when the store was cleared or never populated.
    await hydrateMissingProfiles(globalDb, notInDb);
  }

  // Re-read the global store to pick up whatever hydration wrote, and cache
  // the outcome. DIDs hydration couldn't resolve are cached as a miss so we
  // don't hit the network on every read.
  const recheck = [...notInDb, ...stillMissing];
  if (recheck.length > 0) {
    const ph = recheck.map(() => "?").join(",");
    const afterRows = await globalDb
      .query(
        `select did, handle, name, avatar from profiles where did in (${ph})`,
      )
      .all<{
        did: string;
        handle: string | null;
        name: string | null;
        avatar: string | null;
      }>(...recheck);
    for (const row of afterRows) {
      const entry: CacheEntry = {
        name: row.name,
        handle: row.handle,
        avatar: row.avatar,
        fetchedAt: now,
      };
      cache.set(row.did, entry);
      const fields = entryToFields(entry);
      if (fields) result.set(row.did, fields);
    }
    for (const did of recheck) {
      if (!result.has(did)) {
        // Still unresolvable — cache as a miss (short TTL) so we don't
        // re-fetch on every read.
        cache.set(did, { name: null, handle: null, avatar: null, fetchedAt: now });
      }
    }
  }
}

/**
 * On-demand profile hydration for DIDs missing from the global store.
 *
 * Mirrors the `getProfile` handler: query HappyView (batched) for Roomy
 * profile records, fall back to the Bluesky appview, and write whatever is
 * found into the global `profiles` table (idempotent upsert). Failures are
 * swallowed — the caller returns its existing fallback and the profile is
 * retried on a later read (after the miss cache TTL) or by the event
 * materialisation path.
 */
async function hydrateMissingProfiles(
  globalDb: AsyncDatabase,
  dids: string[],
): Promise<void> {
  if (dids.length === 0) return;
  try {
    if (testGetProfiles) {
      await testGetProfiles(dids);
      return;
    }
    const happyView = getHappyView();
    const { profiles, extras } = await getProfilesRoomyFirst(
      dids as UserDid[],
      happyView,
    );
    if (profiles.length > 0) {
      await insertProfilesWithExtras(globalDb, profiles, extras);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
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
): Promise<void> {
  if (items.length === 0) return;
  const profiles = await resolveProfiles(items.map(getDid));
  for (const item of items) {
    const p = profiles.get(getDid(item));
    if (p) apply(item, p);
  }
}

/** Test helper. */
export function _resetProfileStoreCache(): void {
  cache.clear();
}
