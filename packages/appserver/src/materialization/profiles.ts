/**
 * Profile prefetch + materialisation.
 *
 * Mirrors the frontend `worker.ts → ensureProfiles` flow: scan a batch of
 * events for user DIDs that need a profile, look up which ones we don't yet
 * have, fetch profiles, and write them to the global `profiles` table (the
 * authoritative per-user Roomy profile store).
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


/**
 * Cooldown for re-fetching profiles with stale handles.
 * A user whose handle is `handle.invalid` (expired domain) will be re-checked
 * at most once per this interval, regardless of how many events reference them.
 * Once the handle resolves to something valid, it stops being re-checked.
 */
const STALE_HANDLE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
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
 * `InvalidRequest: Invalid AT identifier`. Backfill batches can reference far
 * more than 25 users, so we chunk into groups of 25 and concatenate.
 */
export const defaultGetProfiles: GetProfilesFn = async (dids: UserDid[]) => {
  if (dids.length === 0) return [];
  const MAX_ACTORS = 25;
  const out: ProfileViewDetailed[] = [];
  try {
    for (let i = 0; i < dids.length; i += MAX_ACTORS) {
      const chunk = dids.slice(i, i + MAX_ACTORS);
      try {
        const params = new URLSearchParams();
        for (const d of chunk) params.append("actors", d);
        const resp = await fetch(
          `https://api.bsky.app/xrpc/app.bsky.actor.getProfiles?${params.toString()}`,
        );
        if (!resp.ok) {
          console.warn(
            `[materialize] defaultGetProfiles: bsky appview returned ${resp.status} for ${chunk.length} DIDs`,
          );
          continue;
        }
        const data = (await resp.json()) as { profiles?: ProfileViewDetailed[] };
        if (data.profiles) out.push(...data.profiles);
      } catch (err) {
        // Per-chunk isolation: a network/parse failure on one chunk must not
        // abort the remaining chunks. Affected DIDs self-heal on the next
        // backfill (profile still missing from the global store →
        // filterMissing returns them).
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[materialize] defaultGetProfiles: chunk failed (${chunk.length} DIDs): ${message}`,
        );
      }
    }
  } catch (err) {
    // Defensive outer guard for unexpected non-fetch errors.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[materialize] defaultGetProfiles: aborted for ${dids.length} DIDs: ${message}`,
    );
  }
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

  const profiles: ProfileViewDetailed[] = [];
  const extras = new Map<string, RoomyProfileExtras>();

  // Step 1: query HappyView for Roomy profile records (batched).
  let missingDids = dids;
  if (happyView) {
    const happyViewResults = await getProfilesFromHappyView(dids, happyView);
    for (const did of dids) {
      const hp = happyViewResults.get(did);
      if (hp) {
        profiles.push(happyViewToProfileView(hp));
        extras.set(did, happyViewExtras(hp));
      }
    }
    missingDids = dids.filter((d) => !happyViewResults.has(d));
  }

  // Step 2: fall back to Bluesky for DIDs HappyView didn't have (or all
  // DIDs when HappyView is not configured).
  if (missingDids.length > 0) {
    // Under `bun test` (NODE_ENV=test) skip the live Bluesky appview fetch.
    // Unit tests that exercise materialization/read paths don't assert on
    // profile rows, and live fetches pile up under parallel load and blow
    // the 5s per-test timeout (see the `_setTestGetProfiles` comment in
    // src/e2e/helpers.ts). Tests that DO exercise the fetcher mock
    // `globalThis.fetch` and call `defaultGetProfiles` directly.
    if (process.env.NODE_ENV === "test") {
      return { profiles, extras };
    }
    const bskyProfiles = await defaultGetProfiles(missingDids);
    profiles.push(...bskyProfiles);
  }

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

  return resolvable.filter((d) => !present.has(d) || staleHandleDids.has(d));
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
 * hydration) rather than being clobbered with an empty string. A Bluesky
 * fallback is first-writer-wins for display fields but always refreshes the
 * handle.
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
  const handle = p.handle ?? null;
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
         handle = coalesce(nullif(excluded.handle, ''), profiles.handle),
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
    await globalDb.run(
      `insert into profiles (did, handle, name, avatar, description, updated_at)
       values (?, ?, ?, ?, ?, unixepoch() * 1000)
       on conflict(did) do update set
         handle = coalesce(excluded.handle, profiles.handle),
         updated_at = unixepoch() * 1000`,
      [did, handle, name, avatar, description],
    );
  }
}

/**
 * Write a `space.roomy.user.updateProfile.v0` (SetUserProfile) event to the
 * global `profiles` table. Called from the materialiser so bridged-user
 * profile updates (which don't go through HappyView) stay fresh in the
 * global store. Only the fields the event carries are updated (coalesce).
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
  const handle = discordOrigin?.handle ?? null;
  const name = typeof event.name === "string" ? event.name : null;
  const avatar = typeof event.avatar === "string" ? event.avatar : null;
  const description =
    typeof event.description === "string" ? event.description : null;
  await globalDb.run(
    `insert into profiles (did, handle, name, avatar, description, updated_at)
     values (?, ?, ?, ?, ?, unixepoch() * 1000)
     on conflict(did) do update set
       handle = coalesce(excluded.handle, profiles.handle),
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
 * Phase 3: profiles are global — the authoritative copy lives in the global
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
