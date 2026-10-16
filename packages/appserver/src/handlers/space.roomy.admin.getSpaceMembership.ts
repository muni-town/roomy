/**
 * XRPC: space.roomy.admin.getSpaceMembership (query, admin-only).
 *
 * Returns the bridge-token capacity picture for one space: every grant,
 * its live Polar-derived capacity, spend state, and the space's
 * maxMembers (the free-tier floor, or the Σ of live grant capacities) vs
 * current member count.
 *
 * The Discord bridge polls this endpoint to decide whether bridging may
 * continue: `overLimit` (memberCount > maxMembers) means the bridge must
 * halt.
 *
 * Per-grant processing (read-time validity):
 *   - Polar validity check per grantor (300s TTL cache). Valid state →
 *     capacity (max of the Roomy Pro subscription 1000 and any
 *     max_members feature_flag benefit); no valid state → 0.
 *   - Spend rule: a grant that is not yet spent is marked spent (PERMANENT)
 *     once the bridged guild's member count exceeds 100 (per
 *     guild-space-tuple; one guild per space assumed v1). Spent locks the
 *     token to this guild — it can no longer be revoked or granted elsewhere
 *     — but does NOT reduce capacity: a spent grant keeps powering its
 *     bridge from the grantor's live Polar state.
 *   - Polar outage / 5xx FAILS OPEN: last-known-valid cached state is
 *     served with `stale: true`; an unknown state is never capacity 0.
 *   - Free tier: every space bridges up to FREE_BRIDGE_CAPACITY members
 *     regardless of grants, so `maxMembers` is never 0.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`). No lexicon —
 * inline admin endpoint following the space.roomy.admin.getDashboardStats
 * pattern. Polar disabled (no POLAR_ACCESS_TOKEN) → 503.
 *
 * Response:
 * {
 *   spaceDid, memberCount, validTokenCount, maxMembers, overLimit, checkedAt,
 *   tokens: [{ grantorDid, capacity, status: "pending"|"spent", live }],
 *   stale: boolean,   // any Polar state served from cache-on-error
 * }
 */

import { openReadStateDb, openSpaceDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { selectGrantsForSpace } from "../queries/bridgeTokens.ts";
import { resolveGrantorCapacityWith } from "../billing/capacity.ts";
import { getPolar } from "../billing/polar.ts";
import { markGrantSpent } from "../queries/bridgeTokens.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

/**
 * Free-tier bridge capacity: a space with no live bridge-token grant still
 * bridges its guild up to this member count. With the bridge's 2x hard stop,
 * free bridging halts at 100 members. Mirrors FREE_BRIDGE_MEMBER_LIMIT in the
 * app's pricing/settings copy (packages/app-lite/src/lib/config.ts).
 */
export const FREE_BRIDGE_CAPACITY = 50;

/**
 * Guilds above this member count spend the bridge token (permanent). Spend
 * locks the token to the guild; it does not reduce the space's capacity.
 */
export const BRIDGE_TOKEN_SPEND_THRESHOLD = 100;

export interface MembershipToken {
  grantorDid: string;
  capacity: number;
  status: "pending" | "spent";
  /** Whether the grantor's Polar state was valid at read time. */
  live: boolean;
}

export interface GetSpaceMembershipResult {
  spaceDid: string;
  tokens: MembershipToken[];
  validTokenCount: number;
  /** max(FREE_BRIDGE_CAPACITY, Σ of live token capacities). */
  maxMembers: number;
  memberCount: number;
  /** memberCount > maxMembers — the bridge must halt. */
  overLimit: boolean;
  /** Any Polar state served from cache because a refresh failed. */
  stale: boolean;
  checkedAt: number;
}

function memberCountOf(spaceDid: string): Promise<number> {
  const spaceDb = openSpaceDb(spaceDid);
  return spaceDb
    .query(
      `select count(*) as n from edges
        where head = ? and label in ('member', 'admin')`,
    )
    .get<{ n: number }>(spaceDid)
    .then((r) => r?.n ?? 0);
}

export const adminGetSpaceMembershipHandler: QueryHandler<
  QueryParams,
  GetSpaceMembershipResult
> = async (params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const config = getPolar();
  if (!config) {
    throw new XrpcError(
      503,
      "ServiceUnavailable",
      "Polar billing is not configured",
    );
  }

  const spaceDid = requireString(params, "spaceId");
  const memberCount = await memberCountOf(spaceDid);

  const readStateDb = openReadStateDb();
  const grants = await selectGrantsForSpace(readStateDb, spaceDid);

  const tokens: MembershipToken[] = [];
  let maxMembers = 0;
  let validTokenCount = 0;
  let stale = false;

  for (const grant of grants) {
    let spent = grant.spent_at !== null;

    // Spend rule: a pending grant whose guild exceeded the threshold is
    // spent now, permanently. Spent locks the token to this guild (no revoke,
    // no re-grant); the capacity below is unaffected by spent.
    if (!spent && memberCount > BRIDGE_TOKEN_SPEND_THRESHOLD) {
      await markGrantSpent(readStateDb, grant.grantor_did);
      spent = true;
    }

    let capacity = 0;
    let live = false;
    try {
      const resolved = await resolveGrantorCapacityWith(config, grant.grantor_did);
      capacity = resolved.capacity;
      live = capacity > 0;
      if (resolved.stale) stale = true;
    } catch {
      // Polar unavailable with nothing cached: fail open — the grant's
      // grant-time snapshot keeps it visible, but it contributes 0 and
      // gets no live flag. Never an error: the space keeps serving on its
      // last-known-valid picture.
      stale = true;
    }

    tokens.push({
      grantorDid: grant.grantor_did,
      capacity,
      status: spent ? "spent" : "pending",
      live,
    });
    if (live) {
      validTokenCount += 1;
      maxMembers += capacity;
    }
  }

  // The free tier always applies: a space with no live grant (or only lapsed
  // ones) still bridges up to FREE_BRIDGE_CAPACITY, so maxMembers is never 0.
  const effectiveMaxMembers = Math.max(FREE_BRIDGE_CAPACITY, maxMembers);

  return {
    spaceDid,
    tokens,
    validTokenCount,
    maxMembers: effectiveMaxMembers,
    memberCount,
    overLimit: memberCount > effectiveMaxMembers,
    stale,
    checkedAt: Date.now(),
  };
};
