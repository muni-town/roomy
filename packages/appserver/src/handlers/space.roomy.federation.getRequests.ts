/**
 * XRPC: space.roomy.federation.getRequests (query).
 *
 * Returns the pending federation requests addressed to a space (A). Visible
 * only to that space's admins, who use it to approve or reject requests.
 */

import { requireFederationAdmin, resolveSpaceName } from "./federationAdmin.ts";
import { resolveProfiles } from "../queries/profileStore.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface RequestRow {
  federatingSpaceDid: string;
  federatingSpaceName?: string;
  requestedByDid: string;
  requestedByName?: string;
  requestedByHandle?: string;
  requestedAt: number;
  message?: string;
}

interface GetRequestsResult {
  requests: RequestRow[];
}

export const getFederationRequestsHandler: QueryHandler<
  QueryParams,
  GetRequestsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const { spaceId, db } = await requireFederationAdmin(
    params,
    auth,
    "federation requests",
  );
  const rows = await db
    .query(
      `select federating_space_did, requested_by_did, requested_at, message
         from space_federations
        where space_id = ? and status = 'pending'
        order by requested_at asc`,
    )
    .all<{
      federating_space_did: string;
      requested_by_did: string;
      requested_at: number;
      message: string | null;
    }>(spaceId);

  const requesterDids = rows.map((r) => r.requested_by_did);
  const profiles = await resolveProfiles(requesterDids);

  return {
    requests: await Promise.all(
      rows.map(async (r) => {
        const requester = profiles.get(r.requested_by_did);
        return {
          federatingSpaceDid: r.federating_space_did,
          ...(await resolveSpaceName(r.federating_space_did).then(
            (name) => (name ? { federatingSpaceName: name } : {}),
          )),
          requestedByDid: r.requested_by_did,
          ...(requester?.name ? { requestedByName: requester.name } : {}),
          ...(requester?.handle ? { requestedByHandle: requester.handle } : {}),
          requestedAt: r.requested_at,
          ...(r.message ? { message: r.message } : {}),
        };
      }),
    ),
  };
};
