/**
 * XRPC: space.roomy.admin.connectSpace (query).
 *
 * Returns basic info about a space — the service DID we authenticated as,
 * plus the rooms list from the materialized DB. Used to validate connectivity
 * from clients.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`). The router has
 * already verified the caller's inter-service JWT.
 */

import { StreamDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface ConnectSpaceResult {
  serviceDid: string;
  streamDid: string;
  roomCount: number;
  rooms: unknown[];
}

export const connectSpaceHandler: QueryHandler<
  QueryParams,
  ConnectSpaceResult
> = async (params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const did = params["did"];
  if (typeof did !== "string" || did === "") {
    throw new XrpcError(400, "InvalidRequest", "missing 'did' query parameter");
  }

  const parsed = StreamDid.assert(did);

  const db = openDb();
  const rooms = await db
    .query(
      `SELECT r.entity as id, i.name, r.label as kind, r.deleted,
              parent_e.head as parent
FROM comp_room r
LEFT JOIN comp_info i ON i.entity = r.entity
LEFT JOIN edges parent_e
  ON parent_e.tail = r.entity
 AND parent_e.label = 'link'
 AND coalesce(json_extract(parent_e.payload, '$.canonical_parent'), 0) = 1
WHERE r.entity IN (SELECT id FROM entities WHERE stream_id = ?)`,
    )
    .all<{ id: string; name: string | null; kind: string | null; deleted: number | null; parent: string | null }>(parsed);

  return {
    serviceDid: process.env.APPSERVER_DID ?? "did:web:api.roomy.space",
    streamDid: parsed,
    roomCount: rooms.length,
    rooms,
  };
};
