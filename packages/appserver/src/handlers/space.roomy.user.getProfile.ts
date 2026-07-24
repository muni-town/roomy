/**
 * XRPC: space.roomy.user.getProfile (query).
 *
 * Returns a user's profile. The `actor` param accepts a DID or handle;
 * handles are resolved to DIDs via the PLC directory.
 *
 * **Read-after-write consistency:** The appserver processes Leaf stream
 * events, not ATProto repo commits, so a `putRecord` to
 * `space.roomy.user.profile/self` on the PDS does not trigger
 * re-materialisation. To stay fresh, this handler always checks HappyView
 * (which indexes the Jetstream firehose and caches Roomy profile records
 * locally) and re-materialises from it when a record exists.
 *
 * When no Roomy record exists in HappyView, it falls back to the
 * materialised `comp_info` row, then to on-demand Bluesky hydration.
 *
 * Profile fields (handle, displayName, etc.) may be absent when the user
 * has no Roomy profile record and no Bluesky profile — that's expected and
 * not an error. Only `did` is always present.
 */

import { openDb } from "../db/db.ts";
import { idResolver } from "../identity.ts";
import { insertProfilesWithExtras, defaultGetProfiles } from "../materialization/profiles.ts";
import { getHappyView } from "../happyview.ts";
import { getProfileFromHappyView, happyViewToProfileView, happyViewExtras } from "../materialization/roomyProfile.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import type { UserDid } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import type { RoomyProfileExtras } from "../materialization/roomyProfile.ts";

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

  // ── Roomy profile record from HappyView (authoritative) ──────────────
  // The appserver processes Leaf stream events, not ATProto repo commits,
  // so a `putRecord` to `space.roomy.user.profile/self` on the PDS does not
  // trigger re-materialisation. HappyView subscribes to the Jetstream
  // firehose and indexes Roomy profile records, so it has the freshest
  // copy. Always check HappyView first and re-materialise from it when a
  // record exists — `insertProfilesWithExtras` uses `on conflict do
  // update` for Roomy-sourced profiles, so this is idempotent.
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

    // Re-read the materialised row to get the handle (Roomy records don't
    // carry one — the handle comes from comp_user, populated by prior
    // Bluesky/Leaf hydration).
    const row = await readProfileRow(db, did);
    return stripNulls({
      did,
      handle: row?.handle,
      displayName: freshPv.displayName,
      avatar: freshPv.avatar,
      description: freshPv.description,
      banner: freshEx.banner,
      pronouns: freshEx.pronouns,
      website: freshEx.website,
    }) as GetProfileResult;
  }

  // ── Materialised row (stale but fast) ─────────────────────────────────
  // No Roomy record in HappyView (or HappyView not configured). Return
  // whatever is materialised — this covers Bluesky-sourced profiles and
  // bridged users whose profile data comes from Leaf stream events.
  const row = await readProfileRow(db, did);
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

  // ── On-demand hydration (no materialised row) ──────────────────────────
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
 * Read the materialised profile row (comp_user + comp_info) for a DID.
 * Returns null when no comp_user row exists (user never seen by the
 * appserver). comp_info fields may be null when the user has comp_user but
 * no materialised profile data.
 */
async function readProfileRow(
  db: DbLike,
  did: string,
): Promise<{
  did: string;
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  description: string | null;
  banner: string | null;
  pronouns: string | null;
  website: string | null;
} | null> {
  return db
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