/**
 * Profile prefetch + materialisation.
 *
 * Mirrors the frontend `worker.ts → ensureProfiles` flow: scan a batch of
 * events for user DIDs that need a profile, look up which ones we don't yet
 * have, bulk-fetch from the bsky appview, and insert `entities` + `comp_user`
 * + `comp_info` rows.
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

/** Event $types that signal a user we may not yet have a profile for. */
const NEW_USER_SIGNALS: EventType[] = [
  "space.roomy.space.addAdmin.v0",
  "space.roomy.space.joinSpace.v0",
  "space.roomy.message.createMessage.v0",
];

export type GetProfilesFn = (dids: UserDid[]) => Promise<ProfileViewDetailed[]>;
/**
 * Default profile fetcher that calls the bsky appview directly.
 * Used when no custom `GetProfilesFn` is provided.
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
 * Ensure entities + comp_user + comp_info rows exist for every user DID
 * referenced by a profile-relevant event in the batch.
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
  const present = new Set(
    (await db
      .query(`select entity from comp_info where entity in (${placeholders})`)
      .all<{ entity: string }>(...resolvable)
    ).map((r) => r.entity),
  );

  return resolvable.filter((d) => !present.has(d));
}

/** Insert one transaction's worth of profile rows. */
async function insertProfiles(db: DbLike, profiles: ProfileViewDetailed[]): Promise<void> {
  const steps: Array<{ type: "query" | "run" | "exec"; sql: string; params?: unknown[] }> = [];
  for (const p of profiles) {
    steps.push({ type: "run", sql: "insert into entities (id, stream_id) values (?, ?) on conflict(id) do nothing", params: [p.did, p.did] });
    steps.push({ type: "run", sql: "insert into comp_user (did, handle) values (?, ?) on conflict(did) do nothing", params: [p.did, p.handle] });
    steps.push({ type: "run", sql: "insert into comp_info (entity, name, avatar) values (?, ?, ?) on conflict(entity) do nothing", params: [p.did, p.displayName ?? p.handle, p.avatar ?? null] });
  }
  await db.transaction(steps);
}
