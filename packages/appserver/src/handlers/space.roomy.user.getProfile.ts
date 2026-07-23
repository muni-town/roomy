/**
 * XRPC: space.roomy.user.getProfile (query).
 *
 * Returns a user's profile from the appserver's materialized data
 * (comp_info/comp_user). The `actor` param accepts a DID or handle; handles
 * are resolved to DIDs via the PLC directory.
 *
 * If the profile isn't yet materialized (the user hasn't appeared in any
 * space event), the handler hydrates it on demand using the Roomy-first
 * fetcher (PDS record → Bluesky fallback), inserts it, and returns it.
 *
 * Profile fields (handle, displayName, etc.) may be absent when the user
 * has no Roomy profile record and no Bluesky profile — that's expected and
 * not an error. Only `did` is always present.
 */

import { openDb } from "../db/db.ts";
import { idResolver } from "../identity.ts";
import { getProfilesRoomyFirst } from "../materialization/profiles.ts";
import { insertProfilesWithExtras } from "../materialization/profiles.ts";
import { getHappyView } from "../happyview.ts";
import { getRoomyProfileRecord, roomyRecordToProfileView, roomyRecordExtras } from "../materialization/roomyProfile.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import type { UserDid } from "@roomy-space/sdk";

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

export const getProfileHandler: QueryHandler<
  QueryParams,
  GetProfileResult
> = async (params: QueryParams, _auth: AuthCtx) => {
  const actor = requireString(params, "actor");

  // Resolve handle → DID if the actor param isn't a DID.
  const did = await resolveActorToDid(actor);

  const db = openDb();

  // Try the materialized tables first.
  const row = await db
    .query(
      `select
        u.did      as did,
        u.handle   as handle,
        i.name     as displayName,
        i.avatar   as avatar,
        i.description as description,
        i.banner   as banner,
        i.pronouns as pronouns,
        i.website  as website
      from comp_user u
      left join comp_info i on i.entity = u.did
      where u.did = ?`,
    )
    .get<{
      did: string;
      handle: string | null;
      displayName: string | null;
      avatar: string | null;
      description: string | null;
      banner: string | null;
      pronouns: string | null;
      website: string | null;
    }>(did);

  if (row) {
    return stripNulls({
      did: row.did,
      handle: row.handle,
      displayName: row.displayName,
      avatar: row.avatar,
      description: row.description,
      banner: row.banner,
      pronouns: row.pronouns,
      website: row.website,
    }) as GetProfileResult;
  }

  // Not materialized — hydrate on demand.
  // Try HappyView/Bluesky batch fetch first (fast path).
  const happyView = getHappyView();
  const { profiles, extras } = await getProfilesRoomyFirst(
    [did as UserDid],
    happyView,
  );
  if (profiles.length > 0) {
    await insertProfilesWithExtras(db, profiles, extras);
    const p = profiles[0]!;
    const ex = extras.get(p.did);
    return stripNulls({
      did: p.did,
      handle: p.handle || undefined,
      displayName: p.displayName,
      avatar: p.avatar,
      description: p.description,
      banner: ex?.banner,
      pronouns: ex?.pronouns,
      website: ex?.website,
    }) as GetProfileResult;
  }

  // Last resort: try a single-DID PDS fetch for the Roomy profile record.
  // This covers the case where HappyView hasn't indexed the record yet but
  // the user has created it. If this also misses, return minimal profile.
  try {
    const record = await getRoomyProfileRecord(did);
    if (record) {
      const pv = roomyRecordToProfileView(did, record);
      const ex = roomyRecordExtras(did, record);
      await insertProfilesWithExtras(db, [pv], new Map([[did, ex]]));
      return stripNulls({
        did,
        displayName: pv.displayName,
        avatar: pv.avatar,
        description: pv.description,
        banner: ex.banner,
        pronouns: ex.pronouns,
        website: ex.website,
      }) as GetProfileResult;
    }
  } catch {
    // PDS unreachable or DID unresolvable — not an error, just no profile.
  }

  // No profile found anywhere — return minimal profile with just the DID.
  return { did };
};

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