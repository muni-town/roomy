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

import { Database } from "bun:sqlite";
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

export type GetProfilesFn = (
  dids: UserDid[],
) => Promise<ProfileViewDetailed[]>;

/**
 * Ensure entities + comp_user + comp_info rows exist for every user DID
 * referenced by a profile-relevant event in the batch.
 *
 * Silent no-op if `getProfiles` is undefined — tests pass no fetcher and
 * don't need profile materialisation.
 */
export async function ensureProfilesForBatch(
  db: Database,
  events: DecodedStreamEvent[],
  getProfiles: GetProfilesFn | undefined,
): Promise<void> {
  if (!getProfiles) return;

  const candidates = collectCandidateDids(events);
  if (candidates.size === 0) return;

  const missing = filterMissing(db, candidates);
  if (missing.length === 0) return;

  const profiles = await getProfiles(missing);
  if (profiles.length === 0) return;

  insertProfiles(db, profiles);
}

/** Scan a batch for user DIDs that warrant a profile lookup. */
function collectCandidateDids(events: DecodedStreamEvent[]): Set<UserDid> {
  const out = new Set<UserDid>();

  for (const e of events) {
    const ev = e.event;
    if (!NEW_USER_SIGNALS.includes(ev.$type as EventType)) continue;

    if (UserDid.allows(e.user)) out.add(UserDid.assert(e.user));

    // createMessage may carry an authorOverride extension that names a
    // different user. Pull that DID too so the override author has a profile.
    if (ev.$type === "space.roomy.message.createMessage.v0") {
      const override =
        ev.extensions?.["space.roomy.extension.authorOverride.v0"]?.did;
      if (override) {
        const parsed = UserDid(override);
        if (
          !(parsed instanceof type.errors) &&
          (parsed.startsWith("did:plc:") || parsed.startsWith("did:web:"))
        ) {
          out.add(parsed);
        }
      }
    }
  }

  return out;
}

/**
 * Narrow to DIDs we can resolve via the bsky appview AND that don't yet have
 * an `entities` row. Only `did:plc:` and `did:web:` are appview-resolvable;
 * other DID methods (e.g. `did:discord:` for bridged users) are skipped here
 * — those entities are created by their respective materialisers.
 */
function filterMissing(db: Database, candidates: Set<UserDid>): UserDid[] {
  const resolvable = [...candidates].filter(
    (d) => d.startsWith("did:plc:") || d.startsWith("did:web:"),
  );
  if (resolvable.length === 0) return [];

  const placeholders = resolvable.map(() => "?").join(",");
  const present = new Set(
    db
      .query<{ id: string }, string[]>(
        `select id from entities where id in (${placeholders})`,
      )
      .all(...resolvable)
      .map((r) => r.id),
  );

  return resolvable.filter((d) => !present.has(d));
}

/** Insert one transaction's worth of profile rows. */
function insertProfiles(db: Database, profiles: ProfileViewDetailed[]): void {
  const insertEntity = db.prepare(
    "insert into entities (id, stream_id) values (?, ?) on conflict(id) do nothing",
  );
  const insertUser = db.prepare(
    "insert into comp_user (did, handle) values (?, ?) on conflict(did) do nothing",
  );
  const insertInfo = db.prepare(
    "insert into comp_info (entity, name, avatar) values (?, ?, ?) on conflict(entity) do nothing",
  );

  const run = db.transaction(() => {
    for (const p of profiles) {
      // The frontend uses the DID as both id and stream_id for users; that
      // matches the comp_user FK shape and keeps queries on the user entity
      // consistent across spaces.
      insertEntity.run(p.did, p.did);
      insertUser.run(p.did, p.handle);
      insertInfo.run(p.did, p.displayName ?? p.handle, p.avatar ?? null);
    }
  });

  run();
}
