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
  type DecodedStreamEvent,
  type EventType,
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
 * Cooldown for re-fetching profiles with stale handles.
 * A user whose handle is `handle.invalid` (expired domain) will be re-checked
 * at most once per this interval, regardless of how many events reference them.
 * Once the handle resolves to something valid, it stops being re-checked.
 */
const STALE_HANDLE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Freshness TTL for *existing* profile rows. A row older than this is
 * eligible for re-fetch on the next event/reference, so a display-name or
 * avatar change on the PDS (Roomy record or Bluesky profile) propagates to
 * message lists without a manual visit to the profile page.
 *
 * Distinct from `STALE_HANDLE_COOLDOWN_MS` (handle-expiry recovery): that is a
 * backoff on an *invalid* handle; this is a periodic refresh of a *valid*
 * row. The two combine — a row is re-fetched when either threshold applies.
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
 * `filterMissing` returns it again and the write path re-runs the full
 * pipeline (HappyView + Bluesky, two HTTP round-trips) on every event by that
 * author, and N concurrent writes by the same unresolved author each issue
 * their own copy.
 *
 * Keyed by DID and shared by both callers of this pipeline: materialisation's
 * `ensureProfilesForBatch`/`ensureProfilesRoomyFirst` and the read path's
 * on-demand hydration, so a failure in one is not repeated by the other.
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

/** Event $types that signal a user we may not yet have a profile for. */
const NEW_USER_SIGNALS: EventType[] = [
  "space.roomy.space.addAdmin.v0",
  "space.roomy.space.joinSpace.v0",
  "space.roomy.message.createMessage.v0",
];

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
  const fetchable = dids.filter((d) => !isProfileFetchBackedOff(d));
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
          log.warn(
            `[materialize] defaultGetProfiles: bsky appview returned ${resp.status} for ${chunk.length} DIDs`,
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

  // DIDs that recently resolved to nothing are skipped entirely — no
  // HappyView call, no Bluesky call — until the backoff elapses.
  const requested = dids.filter((d) => !isProfileFetchBackedOff(d));

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
 * Ensure a global `profiles` row exists for every user DID referenced by a
 * profile-relevant event in the batch.
 *
 * Uses the Roomy-first fetcher (`getProfilesRoomyFirst`) by default. Tests
 * can pass a custom `getProfiles` to bypass HappyView/Bluesky calls.
 *
 * Silent no-op if `getProfiles` is undefined — tests pass no fetcher and
 * don't need profile materialisation.
 */
export async function ensureProfilesForBatch(
  db: DbLike,
  events: DecodedStreamEvent[],
  getProfiles: GetProfilesFn | undefined,
): Promise<void> {
  if (!getProfiles) return;

  const candidates = collectCandidateDids(events);
  if (candidates.size === 0) return;

  const missing = await filterMissing(db, candidates);
  if (missing.length === 0) return;

  const profiles = await getProfiles(missing);
  if (profiles.length === 0) return;

  await insertProfiles(db, profiles);
}

/**
 * Like `ensureProfilesForBatch` but uses the HappyView-first fetcher that
 * queries HappyView in batch, then falls back to Bluesky. Used by the live
 * event stream and backfill paths.
 *
 * When `happyView` is `null`, goes straight to Bluesky (the original fast
 * path). This makes startup re-materialization fast even without HappyView
 * deployed.
 */
export async function ensureProfilesRoomyFirst(
  db: DbLike,
  events: DecodedStreamEvent[],
  happyView: HappyViewConfig | null = null,
): Promise<void> {
  const candidates = collectCandidateDids(events);
  if (candidates.size === 0) return;

  const missing = await filterMissing(db, candidates);
  if (missing.length === 0) return;

  const { profiles, extras } = await getProfilesRoomyFirst(missing, happyView);
  if (profiles.length === 0) return;

  await insertProfilesWithExtras(db, profiles, extras);
}

/** Scan a batch for user DIDs that warrant a profile lookup. */
function collectCandidateDids(events: DecodedStreamEvent[]): Set<UserDid> {
  const candidates = new Set<UserDid>();
  for (const e of events) {
    if (!NEW_USER_SIGNALS.includes(e.event.$type as EventType)) continue;
    const user = e.user;
    if (user && typeof user === "string") {
      candidates.add(user as UserDid);
    }
    // Also collect authorOverride DIDs from createMessage extensions
    if (e.event.$type === "space.roomy.message.createMessage.v0") {
      const ext = (e.event as Record<string, unknown>).extensions as
        | Record<string, unknown>
        | undefined;
      const override = ext?.["space.roomy.extension.authorOverride.v0"] as
        | { did?: string }
        | undefined;
      if (override?.did && typeof override.did === "string") {
        candidates.add(override.did as UserDid);
      }
    }
  }
  return candidates;
}

/**
 * Narrow to DIDs we can resolve via the bsky appview AND that don't yet have
 * a profile row in the global store. DIDs that don't start with `did:plc:` or
 * `did:web:` are skipped — they're synthetic (e.g. `did:space:...`,
 * `did:discord:...`) and have no profile to fetch.
 *
 * We key "have we fetched this profile" off the global `profiles` table (the
 * authoritative per-user Roomy profile store), NOT the per-space
 * `comp_info`/`comp_user` rows: those are a denormalised copy and may lag the
 * global store (or be absent entirely for a space that hasn't re-materialised
 * a cross-stream author). Checking the global store retries until the profile
 * is actually materialised there.
 *
 * When the worker-backed global DB isn't available (e.g. a raw in-memory
 * `Database` in tests), we can't tell which profiles already exist, so we
 * return all resolvable candidates and let the fetch path decide.
 */
async function filterMissing(db: DbLike, candidates: Set<UserDid>): Promise<UserDid[]> {
  const resolvable = [...candidates].filter(
    (d) => d.startsWith("did:plc:") || d.startsWith("did:web:"),
  );
  if (resolvable.length === 0) return [];

  const globalDb = tryOpenGlobalDb();
  // No worker-backed global DB (e.g. a raw in-memory Database in tests) —
  // can't tell which profiles already exist, so return all resolvable
  // candidates.
  if (!globalDb) return resolvable;

  const placeholders = resolvable.map(() => "?").join(",");

  // DIDs that already have a profile in the global store
  const present = new Set(
    (await globalDb
      .query(`select did from profiles where did in (${placeholders})`)
      .all<{ did: string }>(...resolvable)
    ).map((r) => r.did),
  );

  // DIDs with a stale handle.invalid — re-fetch if cooldown has elapsed
  const cutoff = Date.now() - STALE_HANDLE_COOLDOWN_MS;
  const staleHandleDids = new Set(
    (await globalDb
      .query(`select did from profiles where handle = 'handle.invalid' and updated_at < ? and did in (${placeholders})`)
      .all<{ did: string }>(cutoff, ...resolvable)
    ).map((r) => r.did),
  );

  // DIDs whose row is older than the freshness TTL — re-fetch regardless of
  // handle state so a display-name/avatar change on the PDS propagates to
  // message lists instead of the first-fetched values being pinned forever.
  // Bounded by the TTL: a row is re-fetched at most once per interval.
  const refreshCutoff = Date.now() - PROFILE_REFRESH_TTL_MS;
  const staleRows = new Set(
    (await globalDb
      .query(`select did from profiles where updated_at < ? and did in (${placeholders})`)
      .all<{ did: string }>(refreshCutoff, ...resolvable)
    ).map((r) => r.did),
  );

  return resolvable.filter(
    (d) => !present.has(d) || staleHandleDids.has(d) || staleRows.has(d),
  );
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
 * Insert one batch of profile rows (Bluesky-only path) into the global
 * `profiles` table.
 *
 * Profiles are global — the authoritative copy lives in the global
 * `profiles` table. The per-space `entities`/`comp_user`/`comp_info` writes
 * are dropped; per-space DBs keep their own denormalised copy via their own
 * materialisation, and cross-stream reads resolve from the global store.
 */
async function insertProfiles(db: DbLike, profiles: ProfileViewDetailed[]): Promise<void> {
  for (const p of profiles) {
    await writeGlobalProfile(p, undefined);
  }
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
