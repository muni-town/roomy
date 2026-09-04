/**
 * XRPC: space.roomy.federation.getGrants (query).
 *
 * Returns the per-channel federation grants touching a space, for its admins:
 *   - `originGrants`: channels of this space (A) that A has exposed to other
 *     spaces B (`federation_room_permissions`, keyed on the owning space).
 *   - `receiverGrants`: channels of other spaces (origins) that have been
 *     federated *into* this space B, and the receiver grants B's admins have
 *     set for its members/roles (`federation_receiver_permissions`).
 *
 * Feeds the settings Federations UI: the origin-grant toggles (A side) and
 * the receiver-grant config (B side).
 *
 * Both queries join `space_federations` on an active relationship so grants
 * belonging to a removed/rejected federation are not surfaced (they are
 * inert and would only confuse the admin UI).
 */

import { requireFederationAdmin, resolveSpaceName } from "./federationAdmin.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface OriginGrant {
  federatingSpaceDid: string;
  federatingSpaceName?: string;
  roomId: string;
  permission: "read" | "readwrite";
}

interface ReceiverGrant {
  originSpaceId: string;
  originSpaceName?: string;
  roomId: string;
  grantee: string;
  kind: "members" | "user" | "role";
  permission: "read" | "readwrite";
}

interface GetGrantsResult {
  originGrants: OriginGrant[];
  receiverGrants: ReceiverGrant[];
}

export const getFederationGrantsHandler: QueryHandler<
  QueryParams,
  GetGrantsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const { spaceId, db } = await requireFederationAdmin(
    params,
    auth,
    "federation grants",
  );

  const originRows = await db
    .query(
      `select frp.federating_space_did, frp.room_id, frp.permission
         from federation_room_permissions frp
         join space_federations sf
           on sf.space_id = frp.space_id
          and sf.federating_space_did = frp.federating_space_did
        where frp.space_id = ?
          and sf.status = 'active'
        order by frp.federating_space_did, frp.room_id`,
    )
    .all<{
      federating_space_did: string;
      room_id: string;
      permission: "read" | "readwrite";
    }>(spaceId);

  const receiverRows = await db
    .query(
      `select frp.space_id, frp.room_id, frp.grantee, frp.kind, frp.permission
         from federation_receiver_permissions frp
         join space_federations sf
           on sf.space_id = frp.space_id
          and sf.federating_space_did = frp.federating_space_did
        where frp.federating_space_did = ?
          and sf.status = 'active'
        order by frp.space_id, frp.room_id, frp.kind, frp.grantee`,
    )
    .all<{
      space_id: string;
      room_id: string;
      grantee: string;
      kind: "members" | "user" | "role";
      permission: "read" | "readwrite";
    }>(spaceId);

  return {
    originGrants: await Promise.all(
      originRows.map(async (r) => ({
        federatingSpaceDid: r.federating_space_did,
        ...(await resolveSpaceName(r.federating_space_did).then(
          (name) => (name ? { federatingSpaceName: name } : {}),
        )),
        roomId: r.room_id,
        permission: r.permission,
      })),
    ),
    receiverGrants: await Promise.all(
      receiverRows.map(async (r) => ({
        originSpaceId: r.space_id,
        ...(await resolveSpaceName(r.space_id).then((name) =>
          name ? { originSpaceName: name } : {},
        )),
        roomId: r.room_id,
        grantee: r.grantee,
        kind: r.kind,
        permission: r.permission,
      })),
    ),
  };
};
