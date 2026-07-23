/**
 * Profile prefetch + materialisation.
 *
 * Mirrors the frontend `worker.ts → ensureProfiles` flow: scan a batch of
 * events for user DIDs that need a profile, look up which ones we don't yet
 * have, fetch profiles, and insert `entities` + `comp_user` + `comp_info`
 * rows.
 *
 * **HappyView-first with Bluesky fallback.** When a HappyView index service
 * is configured, bulk profile fetches query it in batch (one HTTP call per 25
 * DIDs) for Roomy profile records. DIDs not in HappyView fall back to the
 * Bluesky appview (`app.bsky.actor.getProfiles`). When HappyView is not
 * configured, all fetches go through Bluesky directly — the original fast
 * path.
 *
 * Profile inserts run in their own short transaction *before* the batch's
 * apply transaction. A profile row left behind from a later-failing batch is
 * harmless — `entities` rows are reusable.
 */

import type { DbLike } from "../db/types.ts";
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
        // backfill (comp_info still missing → filterMissing returns them).
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
    const bskyProfiles = await defaultGetProfiles(missingDids);
    profiles.push(...bskyProfiles);
  }

  return { profiles, extras };
}

/**
 * Ensure entities + comp_user + comp_info rows exist for every user DID
 * referenced by a profile-relevant event in the batch.
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
 * a profile row locally. DIDs that don't start with `did:plc:` or
 * `did:web:` are skipped — they're synthetic (e.g. `did:space:...`,
 * `did:discord:...`) and have no profile to fetch.
 *
 * We key "have we fetched this profile" off `comp_info`, NOT `entities`:
 * the message/space materialisers insert `entities` rows for an author
 * independently of any profile fetch (via `ensureEntity`), so an `entities`
 * row can exist with no `comp_info`/`comp_user` — e.g. after a failed fetch.
 * Checking `entities` would permanently skip such DIDs and never retry.
 * Checking `comp_info` retries until the profile is actually materialised.
 */
async function filterMissing(db: DbLike, candidates: Set<UserDid>): Promise<UserDid[]> {
  const resolvable = [...candidates].filter(
    (d) => d.startsWith("did:plc:") || d.startsWith("did:web:"),
  );
  if (resolvable.length === 0) return [];

  const placeholders = resolvable.map(() => "?").join(",");

  // DIDs that already have a profile (comp_info exists)
  const present = new Set(
    (await db
      .query(`select entity from comp_info where entity in (${placeholders})`)
      .all<{ entity: string }>(...resolvable)
    ).map((r) => r.entity),
  );

  // DIDs with a stale handle.invalid — re-fetch if cooldown has elapsed
  const cutoff = Date.now() - STALE_HANDLE_COOLDOWN_MS;
  const staleHandleDids = new Set(
    (await db
      .query(`select did from comp_user where handle = 'handle.invalid' and updated_at < ? and did in (${placeholders})`)
      .all<{ did: string }>(cutoff, ...resolvable)
    ).map((r) => r.did),
  );

  return resolvable.filter((d) => !present.has(d) || staleHandleDids.has(d));
}

/** Insert one transaction's worth of profile rows (Bluesky-only path). */
async function insertProfiles(db: DbLike, profiles: ProfileViewDetailed[]): Promise<void> {
  const steps: Array<{ type: "query" | "run" | "exec"; sql: string; params?: unknown[] }> = [];
  for (const p of profiles) {
    steps.push({ type: "run", sql: "insert into entities (id, stream_id) values (?, ?) on conflict(id) do nothing", params: [p.did, p.did] });
    steps.push({ type: "run", sql: "insert into comp_user (did, handle) values (?, ?) on conflict(did) do update set handle = excluded.handle, updated_at = unixepoch() * 1000", params: [p.did, p.handle] });
    steps.push({ type: "run", sql: "insert into comp_info (entity, name, avatar) values (?, ?, ?) on conflict(entity) do nothing", params: [p.did, p.displayName ?? p.handle, p.avatar ?? null] });
  }
  await db.transaction(steps);
}

/**
 * Insert profile rows with Roomy-specific extras (banner, pronouns, website).
 *
 * Two conflict strategies depending on the source:
 * - **Roomy record**: `on conflict do update` — the Roomy profile record is
 *   the authoritative source and should take precedence over prior data
 *   (e.g. a stale Bluesky fetch or a `SetUserProfile` event).
 * - **Bluesky fallback**: `on conflict do nothing` — first writer wins. This
 *   preserves display names set by `SetUserProfile` events (bridged users)
 *   and avoids overwriting a prior fetch that had a `displayName` with one
 *   that doesn't. Critically, the Bluesky fallback sets `name` to
 *   `displayName ?? handle` — if `displayName` is absent, writing the handle
 *   as the name would clobber a real display name set elsewhere.
 *
 * The `extras` map identifies which profiles came from Roomy records (they
 * have an entry) vs Bluesky (no entry).
 */
export async function insertProfilesWithExtras(
  db: DbLike,
  profiles: ProfileViewDetailed[],
  extras: Map<string, RoomyProfileExtras>,
): Promise<void> {
  const steps: Array<{ type: "query" | "run" | "exec"; sql: string; params?: unknown[] }> = [];
  for (const p of profiles) {
    const ex = extras.get(p.did);
    const isRoomy = ex !== undefined;

    steps.push({ type: "run", sql: "insert into entities (id, stream_id) values (?, ?) on conflict(id) do nothing", params: [p.did, p.did] });

    // Handle: only update from Bluesky-sourced profiles (Roomy records have
    // no handle). For Roomy profiles, insert a null handle row if none exists.
    if (isRoomy) {
      steps.push({ type: "run", sql: "insert into comp_user (did, handle) values (?, ?) on conflict(did) do nothing", params: [p.did, null] });
    } else {
      steps.push({ type: "run", sql: "insert into comp_user (did, handle) values (?, ?) on conflict(did) do update set handle = excluded.handle, updated_at = unixepoch() * 1000", params: [p.did, p.handle] });
    }

    if (isRoomy) {
      // Roomy record: authoritative — overwrite all fields.
      steps.push({
        type: "run",
        sql: "insert into comp_info (entity, name, avatar, description, banner, pronouns, website) values (?, ?, ?, ?, ?, ?, ?) on conflict(entity) do update set name = excluded.name, avatar = excluded.avatar, description = excluded.description, banner = excluded.banner, pronouns = excluded.pronouns, website = excluded.website, updated_at = unixepoch() * 1000",
        params: [
          p.did,
          p.displayName ?? null,
          p.avatar ?? null,
          p.description ?? null,
          ex?.banner ?? null,
          ex?.pronouns ?? null,
          ex?.website ?? null,
        ],
      });
    } else {
      // Bluesky fallback: first writer wins — don't clobber existing names
      // (e.g. display names set by SetUserProfile events for bridged users).
      // Use displayName only (not handle fallback) so we don't write the
      // handle as the name when displayName is absent.
      steps.push({
        type: "run",
        sql: "insert into comp_info (entity, name, avatar, description, banner, pronouns, website) values (?, ?, ?, ?, ?, ?, ?) on conflict(entity) do nothing",
        params: [
          p.did,
          p.displayName ?? null,
          p.avatar ?? null,
          p.description ?? null,
          null,
          null,
          null,
        ],
      });
    }
  }
  await db.transaction(steps);
}
