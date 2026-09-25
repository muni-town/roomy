/**
 * XRPC: space.roomy.user.getProfile (query).
 *
 * Returns a user's profile. The `actor` param accepts a DID or handle;
 * handles are resolved to DIDs via the PLC directory.
 *
 * **Read-after-write consistency:** The appserver processes events from its
 * local event store, not ATProto repo commits, so a `putRecord` to
 * `space.roomy.user.profile/self` on the PDS does not trigger
 * re-materialisation. To stay fresh, this handler always checks HappyView
 * (which indexes the Jetstream firehose and caches Roomy profile records
 * locally) and re-materialises from it when a record exists.
 *
 * When no Roomy record exists in HappyView, it falls back to the global
 * `profiles` row, then to on-demand Bluesky hydration.
 *
 * **Handles.** A Roomy profile record carries no handle, so for a user whose
 * only profile source is a Roomy record the global `profiles` row is the sole
 * place a handle can come from. When that row has no usable handle — absent or
 * persisted empty — the handler resolves one from the Bluesky appview and
 * persists it, rather than returning an empty handle. See `hydrateHandle`.
 *
 * Profile fields (handle, displayName, etc.) may be absent when the user
 * has no Roomy profile record and no Bluesky profile — that's expected and
 * not an error. Only `did` is always present.
 */

import { openGlobalDb } from "../db/db.ts";
import { idResolver } from "../identity.ts";
import { insertProfilesWithExtras, defaultGetProfiles } from "../materialization/profiles.ts";
import { getHappyView } from "../happyview.ts";
import {
  getProfileFromHappyView,
  getRoomyProfileRecord,
  happyViewToProfileView,
  happyViewExtras,
  roomyRecordToProfileView,
  roomyRecordExtras,
} from "../materialization/roomyProfile.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import { log } from "../log.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import type { UserDid } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import type { RoomyProfileExtras, RoomyProfileRecord } from "../materialization/roomyProfile.ts";

export interface GetProfileResult {
  did: string;
  handle?: string;
  displayName?: string;
  description?: string;
  pronouns?: string;
  website?: string;
  avatar?: string;
  banner?: string;
}

/**
 * A row of the global `profiles` table. Fields are null (not absent) when the
 * user has a row but no value for that field.
 */
interface ProfileRow {
  did: string;
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  description: string | null;
  banner: string | null;
  pronouns: string | null;
  website: string | null;
}

export const getProfileHandler: QueryHandler<
  QueryParams,
  GetProfileResult
> = async (params: QueryParams, _auth: AuthCtx) => {
  const actor = requireString(params, "actor");

  // Resolve handle → DID if the actor param isn't a DID.
  const did = await resolveActorToDid(actor);

  const db = openGlobalDb();

  // ── Roomy profile record from the PDS (authoritative) ─────────────────
  // The write path confirms the record on the PDS (`putRecord` with the
  // `atproto-proxy` header). The PDS is the record's source of truth, and
  // read-after-write consistency requires that a just-confirmed write is
  // immediately visible. HappyView is Jetstream-fed and eventually-consistent:
  // immediately after a `putRecord` it may still serve the pre-write snapshot,
  // and re-materialising from that clobbers the global `profiles` row with
  // stale data, so it can never be the primary source. The PDS is consulted
  // first; HappyView is only a fallback when the PDS has no record.
  let pdsRecord: RoomyProfileRecord | null = null;
  try {
    pdsRecord = await getRoomyProfileRecord(did);
  } catch (err) {
    // Unresolvable DID (bridged/synthetic) or unreachable/slow PDS — fall
    // through to HappyView/row/Bluesky rather than failing the read.
    log.warn(
      `[getProfile] PDS record fetch failed for ${did}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (pdsRecord) {
    const pdsPv = roomyRecordToProfileView(did, pdsRecord);
    const pdsEx = roomyRecordExtras(did, pdsRecord);
    await insertProfilesWithExtras(
      db,
      [pdsPv],
      new Map([[did, pdsEx]]),
    );

    // Re-read the global profile row to get the handle (Roomy records don't
    // carry one — the handle comes from the global `profiles` row, populated
    // by prior Bluesky/hydration). If that row has no usable handle, resolve
    // one from Bluesky now instead of returning an empty handle: a Roomy
    // record may be this user's only profile source, and the handle is
    // publicly resolvable.
    let row = await readProfileRow(db, did);
    if (!row?.handle) row = await hydrateHandle(db, did) ?? row;
    return stripNulls({
      did,
      handle: row?.handle || undefined,
      displayName: pdsPv.displayName,
      avatar: pdsPv.avatar,
      description: pdsPv.description,
      banner: pdsEx.banner,
      pronouns: pdsEx.pronouns,
      website: pdsEx.website,
    }) as GetProfileResult;
  }

  // ── Roomy profile record from HappyView ──────────────────────────────
  // No Roomy record on the PDS (user hasn't written one). Fall back to
  // HappyView's indexed copy, re-materialising it so the global row stays
  // fresh for the materialisation read paths that don't hit the PDS.
  const happyView = getHappyView();
  let freshPv: ProfileViewDetailed | null = null;
  let freshEx: RoomyProfileExtras | null = null;

  if (happyView) {
    const hp = await getProfileFromHappyView(did as UserDid, happyView);
    if (hp) {
      freshPv = happyViewToProfileView(hp);
      freshEx = happyViewExtras(hp);
    }
  }

  if (freshPv && freshEx) {
    await insertProfilesWithExtras(
      db,
      [freshPv],
      new Map([[did, freshEx]]),
    );

    let row = await readProfileRow(db, did);
    if (!row?.handle) row = await hydrateHandle(db, did) ?? row;
    return stripNulls({
      did,
      handle: row?.handle || undefined,
      displayName: freshPv.displayName,
      avatar: freshPv.avatar,
      description: freshPv.description,
      banner: freshEx.banner,
      pronouns: freshEx.pronouns,
      website: freshEx.website,
    }) as GetProfileResult;
  }

  // ── Global profile row (stale but fast) ────────────────────────────────
  // No Roomy record in HappyView (or HappyView not configured). Return
  // whatever is in the global `profiles` table — this covers Bluesky-sourced
  // profiles and bridged users whose profile data comes from event
  // processing. A row whose handle was never fetched or is persisted empty
  // gets one resolved and persisted before we answer.
  let row = await readProfileRow(db, did);
  if (row) {
    if (!row.handle) row = await hydrateHandle(db, did) ?? row;
    return stripNulls({
      did: row.did,
      handle: row.handle || undefined,
      displayName: row.displayName,
      avatar: row.avatar,
      description: row.description,
      banner: row.banner,
      pronouns: row.pronouns,
      website: row.website,
    }) as GetProfileResult;
  }

  // ── On-demand hydration (no global profile row) ────────────────────────
  // Try Bluesky batch fetch as a last resort.
  const bskyProfiles = await defaultGetProfiles([did as UserDid]);
  if (bskyProfiles.length > 0) {
    await insertProfilesWithExtras(db, bskyProfiles, new Map());
    const p = bskyProfiles[0]!;
    return stripNulls({
      did: p.did,
      handle: p.handle || undefined,
      displayName: p.displayName,
      avatar: p.avatar,
      description: p.description,
    }) as GetProfileResult;
  }

  // No profile found anywhere — return minimal profile with just the DID.
  return { did };
};

/**
 * Resolve a handle for `did` from the Bluesky appview and persist it to the
 * global `profiles` row, returning that row.
 *
 * Used when the global row exists but carries no usable handle. Roomy profile
 * records don't store a handle and the `space.roomy.user.updateProfile`
 * materialiser only writes one for Discord-origin users, so for everyone else
 * the handle has to come from the ATProto profile — which is where the
 * `getProfile` UI gets it from anyway.
 *
 * The write goes through `insertProfilesWithExtras` with no extras, i.e. the
 * Bluesky merge strategy: the handle is refreshed unconditionally while
 * display fields (name/avatar/description) set by the Roomy record or a
 * bridged profile update are preserved. Returns `null` when Bluesky doesn't
 * know the DID or the fetch fails — the caller answers with what it already
 * has, and a later read retries.
 */
async function hydrateHandle(
  db: DbLike,
  did: string,
): Promise<ProfileRow | null> {
  // Only real ATProto identifiers resolve through the appview; synthetic DIDs
  // (`did:discord:`, `did:space:`) have no profile to fetch.
  if (!did.startsWith("did:plc:") && !did.startsWith("did:web:")) return null;

  const profiles = await defaultGetProfiles([did as UserDid]);
  const p = profiles[0];
  if (!p?.handle) return null;

  await insertProfilesWithExtras(db, [p], new Map());
  return readProfileRow(db, did);
}

/**
 * Read the profile row from the global `profiles` table (the authoritative
 * per-user Roomy profile store). Returns null when no row exists (user never
 * seen by the appserver). Fields may be null when the user has a row but no
 * profile data for a given field.
 */
async function readProfileRow(
  db: DbLike,
  did: string,
): Promise<ProfileRow | null> {
  return db
    .query(
      `select
        did,
        handle,
        name     as displayName,
        avatar,
        description,
        banner,
        pronouns,
        website
      from profiles
      where did = ?`,
    )
    .get<ProfileRow>(did);
}

/**
 * Resolve an `actor` param (DID or handle) to a DID.
 *
 * DIDs (strings starting with `did:`) are returned as-is. Handles are
 * resolved via the PLC directory. Throws 404 if the handle can't be resolved.
 */
async function resolveActorToDid(actor: string): Promise<string> {
  if (actor.startsWith("did:")) return actor;

  // It's a handle — resolve via PLC.
  try {
    const did = await idResolver.handle.resolve(actor);
    if (!did) {
      throw new XrpcError(404, "ActorNotFound", `Could not resolve handle: ${actor}`);
    }
    return did;
  } catch (err) {
    if (err instanceof XrpcError) throw err;
    throw new XrpcError(
      404,
      "ActorNotFound",
      `Could not resolve handle: ${actor}`,
    );
  }
}