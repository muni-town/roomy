/**
 * XRPC: space.roomy.admin.connectSpace (query).
 *
 * Lazily connects to a Roomy space stream via RoomyServiceClient and returns
 * basic info — the service DID we authenticated as, plus the rooms list from
 * the space module. Used to validate Leaf connectivity from clients.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`). The router has
 * already verified the caller's inter-service JWT.
 */

import { StreamDid, type } from "@roomy-space/sdk";
import { getConnectedSpace, getServiceClient } from "../serviceClient.ts";
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

  const parsed = StreamDid(did);
  if (parsed instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `invalid stream DID: ${parsed.summary}`,
    );
  }

  const client = await getServiceClient();
  const space = await getConnectedSpace(parsed);
  const rooms = await space.fetchRooms();
  return {
    serviceDid: client.serviceDid,
    streamDid: parsed,
    roomCount: rooms.length,
    rooms,
  };
};
