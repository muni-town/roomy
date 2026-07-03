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
 * an entity row in the local DB. DIDs that don't start with `did:plc:` or
 * `did:web:` are skipped — they're synthetic (e.g. `did:space:...`) and have
 * no profile to fetch.
 */
async function filterMissing(db: DbLike, candidates: Set<UserDid>): Promise<UserDid[]> {
  const resolvable = [...candidates].filter(
    (d) => d.startsWith("did:plc:") || d.startsWith("did:web:"),
  );
  if (resolvable.length === 0) return [];

  const placeholders = resolvable.map(() => "?").join(",");
  const present = new Set(
    (await db
      .query(`select id from entities where id in (${placeholders})`)
      .all<{ id: string }>(...resolvable)
    ).map((r) => r.id),
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
