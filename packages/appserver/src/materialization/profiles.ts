/**
 * Profile prefetch + materialisation.
 *
 * Scan a batch of events for user DIDs that need a profile, look up which ones
 * we don't yet have, fetch profiles, and write them to the global `profiles`
 * table (the authoritative per-user Roomy profile store).
 *
 * **HappyView-first with Bluesky fallback.** When a HappyView index service
 * is configured, bulk profile fetches query it in batch (one HTTP call per 25
 * DIDs) for Roomy profile records. DIDs not in HappyView fall back to the
 * Bluesky appview (`app.bsky.actor.getProfiles`). When HappyView is not
 * configured, all fetches go through Bluesky directly — the original fast
 * path.
 *
 * Profile writes go to the global DB (via `tryOpenGlobalDb()`), not the
 * per-space DBs. A profile row left behind from a later-failing batch is
 * harmless — the global `profiles` upsert is idempotent.
 */

import type { DbLike } from "../db/types.ts";
import { tryOpenGlobalDb } from "../db/db.ts";
import {
  UserDid,
  type,
} from "@roomy-space/sdk";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import {
  getProfilesFromHappyView,
  happyViewToProfileView,
  happyViewExtras,
  type RoomyProfileExtras,
} from "./roomyProfile.ts";
import type { HappyViewConfig } from "../happyview.ts";
import { fetchWithTimeout } from "../fetchTimeout.ts";
import { log } from "../log.ts";


/**
 * Freshness TTL for *existing* profile rows. A row older than this is
 * eligible for re-fetch on the next read that resolves it, so a display-name
 * or avatar change on the PDS (Roomy record or Bluesky profile) propagates to
 * message lists without a manual visit to the profile page.
 *
 * Exported so the read path (profileStore's on-demand hydration) honours the
 * same cadence instead of drifting.
 */
export const PROFILE_REFRESH_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Negative cache: how long a DID that resolved to no profile at all is kept
 * out of the fetch path.
 *
 * A cache row is only written from a successful fetch result, so a DID that
 * neither HappyView nor the Bluesky appview can resolve — a brand-new DID, a
 * `did:web`, an appview hiccup — has no row to find. Without this backoff
 * the negative cache returns it again, the read path re-runs the full
 * pipeline (HappyView + Bluesky, two HTTP round-trips) on every read by that
 * author, and N concurrent reads by the same unresolved author each issue
 * their own copy.
 *
 * Keyed by DID and shared by every caller of this pipeline — the read path's
 * on-demand hydration and the profile page — so a failure in one is not
 * repeated by the other.
 *
 * The TTL is deliberately short (a minute, not the stale-handle cooldown's
 * hour): a DID that resolves nowhere *today* may be a user whose Roomy profile
 * record HappyView has simply not indexed yet, and backing that off for long
 * would leave their messages authored by a blank name long after the record
 * exists. One minute bounds that staleness while still collapsing the
 * per-event stampede — the fetch cost becomes one lookup per DID per minute
 * instead of one per event and per reader.
 */
const NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 1 minute
/** DIDs whose last fetch resolved nothing, mapped to when it happened. */
const negativeCache = new Map<string, number>();

/**
 * True when a recent lookup for `did` resolved to nothing and the backoff has
 * not elapsed. Exported so callers that reach a fetch *outside* this
 * pipeline's guards (the read path decides on-demand hydration for itself)
 * can skip the work rather than rediscovering the failure.
 */
export function isProfileFetchBackedOff(did: string): boolean {
  const at = negativeCache.get(did);
  if (at === undefined) return false;
  if (Date.now() - at >= NEGATIVE_CACHE_TTL_MS) {
    negativeCache.delete(did);
    return false;
  }
  return true;
}

/**
 * Record the DIDs a fetch left unresolved, for `NEGATIVE_CACHE_TTL_MS`.
 * Only successful lookups are re-fetched sooner (see `isProfileFetchBackedOff`).
 *
 * The read path also calls this: in tests its fetcher stub replaces the
 * pipeline, so the backoff has to be applied at that seam too.
 */
export function recordUnresolvedProfiles(
  requested: readonly string[],
  resolved: ReadonlySet<string>,
): void {
  const now = Date.now();
  // Drop stale entries first, so the map cannot grow without bound on a
  // process that sees many one-off DIDs.
  for (const [did, at] of negativeCache) {
    if (now - at >= NEGATIVE_CACHE_TTL_MS) negativeCache.delete(did);
  }
  for (const did of requested) {
    if (!resolved.has(did)) negativeCache.set(did, now);
  }
}

/** Test helper: clear the negative cache. */
export function _resetProfileNegativeCache(): void {
  negativeCache.clear();
}

/**
 * The DIDs from `dids` worth sending to a profile source: a DID shape with a
 * method segment and something after it, and not currently backed off.
 *
 * Both fetch sites pass their DIDs through here — the write path
 * (`getProfilesRoomyFirst`, which also feeds HappyView) and the read path's
 * hydration (`hydrateMissingProfiles`) — so an unreadable identifier is
 * dropped the same way wherever the set is collected.
 *
 * The shape test is not cosmetic: a message row with no author materialises as
 * `authorDid: ""` (`selectMessages`), and that empty string reaches this
 * pipeline as if it were a DID. `app.bsky.actor.getProfiles` rejects the
 * *whole* request when any `actors` value is empty (400 `InvalidRequest`,
 * "Missing required key \"actors\""), which costs every other DID in the
 * 25-actor chunk its profile. Synthetic but well-formed identifiers
 * (`did:discord:…`, `did:space:…`) are accepted by the appview and answer with
 * no profiles, so the bar is shape, not resolvability.
 *
 * Unreadable DIDs are recorded in the negative cache on the way past: they
 * resolve to nothing, and the fetch set is rebuilt from message rows on every
 * read, so without the record each rebuild would keep re-adding them.
 */
export function fetchableProfileDids(dids: readonly string[]): UserDid[] {
  const fetchable: UserDid[] = [];
  const unreadable: string[] = [];
  for (const did of dids) {
    if (!/^did:[a-z]+:.+$/.test(did)) {
      unreadable.push(did);
    } else if (!isProfileFetchBackedOff(did)) {
      fetchable.push(did as UserDid);
    }
  }
  if (unreadable.length > 0) {
    recordUnresolvedProfiles(unreadable, new Set<string>());
  }
  return fetchable;
}

export type GetProfilesFn = (dids: UserDid[]) => Promise<ProfileViewDetailed[]>;
/**
 * Bluesky appview profile fetcher — the fallback when no Roomy profile record
 * exists.
 *
 * The appview's `app.bsky.actor.getProfiles` takes `actors` as an *array*
 * (repeated `actors=` query keys, NOT a comma-joined string) and caps at 25
 * actors per request — exceeding either yields HTTP 400
 * `Invalid AT identifier`. Backfill batches can reference far more than 25
 * users, so we chunk into groups of 25 and concatenate.
 *
 * Every outbound profile lookup in the appserver funnels through here (the
 * materialisation pipeline and the read path's on-demand hydration both call
 * it), which makes it the one place where a failed resolution can be
 * remembered for all of them.
 */
export const defaultGetProfiles: GetProfilesFn = async (dids: UserDid[]) => {
  if (dids.length === 0) return [];
  const fetchable = fetchableProfileDids(dids);
  if (fetchable.length === 0) return [];
  const MAX_ACTORS = 25;
  const out: ProfileViewDetailed[] = [];
  try {
    for (let i = 0; i < fetchable.length; i += MAX_ACTORS) {
      const chunk = fetchable.slice(i, i + MAX_ACTORS);
      try {
        const params = new URLSearchParams();
        for (const d of chunk) params.append("actors", d);
        const resp = await fetchWithTimeout(
          `https://api.bsky.app/xrpc/app.bsky.actor.getProfiles?${params.toString()}`,
        );
        if (!resp.ok) {
          // The appview rejects the whole chunk on one bad actor, so the DIDs
          // it was asked about are the only record of what caused it.
          log.warn(
            `[materialize] defaultGetProfiles: bsky appview returned ${resp.status} for ${chunk.length} DIDs: ${chunk.join(", ")}`,
          );
          continue;
        }
        const data = (await resp.json()) as { profiles?: ProfileViewDetailed[] };
        if (data.profiles) out.push(...data.profiles);
      } catch (err) {
        // Per-chunk isolation: a network/parse failure on one chunk must not
        // abort the remaining chunks. Affected DIDs are backed off below and
        // retried after `NEGATIVE_CACHE_TTL_MS`.
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          `[materialize] defaultGetProfiles: chunk failed (${chunk.length} DIDs): ${message}`,
        );
      }
    }
  } catch (err) {
    // Defensive outer guard for unexpected non-fetch errors.
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      `[materialize] defaultGetProfiles: aborted for ${dids.length} DIDs: ${message}`,
    );
  }
  // `getProfile` calls this directly as a last resort, so the backoff is
  // enforced here too — not only in the pipeline that normally calls it.
  recordUnresolvedProfiles(fetchable, new Set(out.map((p) => p.did)));
  return out;
};

/**
 * HappyView-first profile fetcher: queries a HappyView index service in
 * batch for Roomy profile records, then falls back to the Bluesky appview
 * for DIDs HappyView doesn't have.
 *
 * When HappyView is not configured (`null`), skips straight to Bluesky —
 * the original fast batched path, no per-DID PDS round-trips.
 *
 * Roomy profile records carry no handle, so a HappyView hit supplies display
 * fields but not the handle. Those DIDs also go to Bluesky, whose handle is
 * merged onto the Roomy profile — the Roomy record stays authoritative for
 * name/avatar/description, and the handle (which only the ATProto profile
 * knows) gets filled in.
 *
 * Returns `{ profiles, extras }` where `profiles` is the
 * `ProfileViewDetailed[]` for `insertProfilesWithExtras` and `extras` maps
 * DIDs to Roomy-specific fields (pronouns, website, banner) that
 * `ProfileViewDetailed` doesn't carry. Only DIDs sourced from HappyView
 * have extras entries.
 */
export async function getProfilesRoomyFirst(
  dids: UserDid[],
  happyView: HappyViewConfig | null = null,
): Promise<{ profiles: ProfileViewDetailed[]; extras: Map<string, RoomyProfileExtras> }> {
  if (dids.length === 0) return { profiles: [], extras: new Map() };

  // DIDs that are unreadable or recently resolved to nothing are skipped
  // entirely — no HappyView call, no Bluesky call — until the backoff
  // elapses.
  const requested = fetchableProfileDids(dids);
  const profiles: ProfileViewDetailed[] = [];
  const extras = new Map<string, RoomyProfileExtras>();

  // Step 1: query HappyView for Roomy profile records (batched).
  let roomyProfiles: { did: UserDid; pv: ProfileViewDetailed }[] = [];
  let missingDids = requested;
  if (happyView) {
    const happyViewResults = await getProfilesFromHappyView(requested, happyView);
    for (const did of requested) {
      const hp = happyViewResults.get(did);
      if (hp) {
        const pv = happyViewToProfileView(hp);
        roomyProfiles.push({ did, pv });
        profiles.push(pv);
        extras.set(did, happyViewExtras(hp));
      }
    }
    missingDids = requested.filter((d) => !happyViewResults.has(d));
  }

  // Step 2: query Bluesky for the DIDs HappyView didn't have (or all of them
  // when HappyView is not configured), plus the Roomy records that carry no
  // handle — only the ATProto profile knows it — then merge those handles onto
  // the Roomy profiles. Under `bun test` (NODE_ENV=test) the live appview
  // fetch is skipped: unit tests that exercise materialization/read paths
  // don't assert on profile rows, and live fetches pile up under parallel load
  // and blow the 5s per-test timeout (see the `_setTestGetProfiles` comment in
  // src/e2e/helpers.ts). Tests that DO exercise the fetcher mock
  // `globalThis.fetch` and call `defaultGetProfiles` directly.
  const handlelessDids = roomyProfiles
    .filter((r) => !r.pv.handle)
    .map((r) => r.did);
  const bskyDids = [...new Set([...missingDids, ...handlelessDids])];
  if (bskyDids.length > 0 && process.env.NODE_ENV !== "test") {
    const bskyProfiles = await defaultGetProfiles(bskyDids);
    const handleByDid = new Map(
      bskyProfiles
        .filter((p) => p.handle)
        .map((p) => [p.did, p.handle] as const),
    );
    const missing = new Set(missingDids);
    for (const { did, pv } of roomyProfiles) {
      if (pv.handle) continue;
      const bskyHandle = handleByDid.get(did);
      if (bskyHandle) pv.handle = bskyHandle;
    }
    // Only the DIDs HappyView had no record for become their own rows; the
    // handle-less Roomy ones were already merged above, and writing them a
    // second time would be redundant.
    profiles.push(...bskyProfiles.filter((p) => missing.has(p.did as UserDid)));
  }

  // Every source has now been asked (or, under `bun test`, the only source
  // that exists in this environment has been). Anything still absent is
  // unresolvable, so back it off instead of re-running both lookups on the
  // next event or read — without the backoff the same unresolvable author is
  // re-fetched forever.
  recordUnresolvedProfiles(requested, new Set(profiles.map((p) => p.did)));

  return { profiles, extras };
}

/**
 * Write a profile to the global `profiles` table (the authoritative per-user
 * Roomy profile store). The atproto collection lexicon defines one global
 * profile per user, so this is the cross-space home for profile data; the
 * per-space DBs keep a denormalised copy (comp_user/comp_info) for fast
 * per-space reads.
 *
 * Conflict strategy mirrors comp_info: a Roomy record is authoritative and
 * overwrites all fields *except the handle* — Roomy profile records
 * (`space.roomy.user.profile/self`) don't carry a handle, so the handle is
 * preserved from the existing row (populated by a prior Bluesky fetch /
 * hydration) rather than being clobbered. A Bluesky fallback is
 * null-preserving for all fields (a `NULL` incoming value never clobbers an
 * existing one) and always refreshes the handle, so a display-name or avatar
 * change picked up by a periodic re-fetch (see `PROFILE_REFRESH_TTL_MS`)
 * propagates rather than pinning the first-fetched value.
 *
 * The handle is normalized on both sides of the merge: `""` from the incoming
 * profile is treated as absent (so it can't overwrite a real handle), and a
 * `''` already in the column is healed to the incoming handle. Both sides go
 * through `nullif(..., '')` for exactly that reason — `''` and "no handle" are
 * the same state as far as every reader is concerned, so a row holding `''`
 * recovers on the next write without a migration.
 */
async function writeGlobalProfile(
  p: ProfileViewDetailed,
  ex: RoomyProfileExtras | undefined,
): Promise<void> {
  const globalDb = tryOpenGlobalDb();
  // No worker-backed global DB (e.g. a raw in-memory Database in tests) —
  // skip the global write.
  if (!globalDb) return;
  const isRoomy = ex !== undefined;
  const did = p.did;
  const handle = p.handle || null;
  const name = p.displayName ?? null;
  const avatar = p.avatar ?? null;
  const description = p.description ?? null;
  const banner = ex?.banner ?? null;
  const pronouns = ex?.pronouns ?? null;
  const website = ex?.website ?? null;

  if (isRoomy) {
    await globalDb.run(
      `insert into profiles (did, handle, name, avatar, description, banner, pronouns, website, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000)
       on conflict(did) do update set
         handle = coalesce(nullif(excluded.handle, ''), nullif(profiles.handle, '')),
         name = excluded.name,
         avatar = excluded.avatar,
         description = excluded.description,
         banner = excluded.banner,
         pronouns = excluded.pronouns,
         website = excluded.website,
         updated_at = unixepoch() * 1000`,
      [did, handle, name, avatar, description, banner, pronouns, website],
    );
  } else {
    // Bluesky-sourced profile. The merge is null-preserving rather than
    // first-writer-wins for display fields: with a profile-refresh TTL driving
    // periodic re-fetches (see `PROFILE_REFRESH_TTL_MS`), a user who changes
    // their display name or avatar on Bluesky must see that change propagate
    // instead of the row pinning the first-fetched value forever. A `NULL`
    // incoming value still never clobbers an existing one (handles, and the
    // case where a fetch just lacks a field), so nothing is lost when the
    // source omits a field. Roomy records (the `isRoomy` branch) overwrite
    // unconditionally because they are the authoritative per-user profile.
    await globalDb.run(
      `insert into profiles (did, handle, name, avatar, description, updated_at)
       values (?, ?, ?, ?, ?, unixepoch() * 1000)
       on conflict(did) do update set
         handle = coalesce(nullif(excluded.handle, ''), nullif(profiles.handle, '')),
         name = coalesce(excluded.name, profiles.name),
         avatar = coalesce(excluded.avatar, profiles.avatar),
         description = coalesce(excluded.description, profiles.description),
         updated_at = unixepoch() * 1000`,
      [did, handle, name, avatar, description],
    );
  }
}

/**
 * Write a `space.roomy.user.updateProfile.v0` (SetUserProfile) event to the
 * global `profiles` table. Called from the materialiser so bridged-user
 * profile updates (which don't go through HappyView) stay fresh in the
 * global store. Only the fields the event carries are updated (coalesce), and
 * an absent/empty Discord-origin handle is treated the same as no handle —
 * see `writeGlobalProfile`.
 */
export async function writeSetUserProfileToGlobal(event: {
  did: string;
  name?: unknown;
  avatar?: unknown;
  description?: unknown;
  extensions?: Record<string, unknown>;
}): Promise<void> {
  const globalDb = tryOpenGlobalDb();
  if (!globalDb) return;
  const discordOrigin = event.extensions?.[
    "space.roomy.extension.discordUserOrigin.v0"
  ] as { handle?: string } | undefined;
  const handle = discordOrigin?.handle || null;
  const name = typeof event.name === "string" ? event.name : null;
  const avatar = typeof event.avatar === "string" ? event.avatar : null;
  const description =
    typeof event.description === "string" ? event.description : null;
  await globalDb.run(
    `insert into profiles (did, handle, name, avatar, description, updated_at)
     values (?, ?, ?, ?, ?, unixepoch() * 1000)
     on conflict(did) do update set
      handle = coalesce(nullif(excluded.handle, ''), nullif(profiles.handle, '')),
       name = coalesce(excluded.name, profiles.name),
       avatar = coalesce(excluded.avatar, profiles.avatar),
       description = coalesce(excluded.description, profiles.description),
       updated_at = unixepoch() * 1000`,
    [event.did, handle, name, avatar, description],
  );
}

/**
 * Insert profile rows with Roomy-specific extras (banner, pronouns, website)
 * into the global `profiles` table.
 *
 * Two conflict strategies depending on the source:
 * - **Roomy record**: `on conflict do update` — the Roomy profile record is
 *   the authoritative source and should take precedence over prior data
 *   (e.g. a stale Bluesky fetch or a `SetUserProfile` event).
 * - **Bluesky fallback**: first writer wins — `handle` is always refreshed
 *   but display fields (name/avatar/description) are only set when absent.
 *   This preserves display names set by `SetUserProfile` events (bridged
 *   users) and avoids overwriting a prior fetch that had a `displayName`
 *   with one that doesn't.
 *
 * The `extras` map identifies which profiles came from Roomy records (they
 * have an entry) vs Bluesky (no entry).
 */
export async function insertProfilesWithExtras(
  db: DbLike,
  profiles: ProfileViewDetailed[],
  extras: Map<string, RoomyProfileExtras>,
): Promise<void> {
  for (const p of profiles) {
    const ex = extras.get(p.did);
    await writeGlobalProfile(p, ex);
  }
}
