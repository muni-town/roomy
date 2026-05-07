/**
 * Debug endpoint: GET /debug/connect-space?did=<streamDid>
 *
 * Connects (lazily, cached) to a Leaf space stream via RoomyServiceClient
 * and returns basic info — the service DID we authenticated as, plus the
 * rooms list from the space module — to validate the connection works.
 *
 * Admin-only: caller must hold a valid inter-service JWT for a DID listed in
 * `APPSERVER_ADMIN_DIDS`. Authorisation is handled by `withAdmin`.
 */

import { StreamDid, type } from "@roomy-space/sdk";
import { getConnectedSpace, getServiceClient } from "../serviceClient.ts";
import { withAdmin } from "../admin.ts";

export async function handleDebugConnectSpace(req: Request): Promise<Response> {
  return withAdmin(req, async () => {
    const url = new URL(req.url);
    const did = url.searchParams.get("did");
    if (!did) {
      return Response.json(
        { error: "BadRequest", message: "missing 'did' query parameter" },
        { status: 400 },
      );
    }

    const parsed = StreamDid(did);
    if (parsed instanceof type.errors) {
      return Response.json(
        {
          error: "BadRequest",
          message: `invalid stream DID: ${parsed.summary}`,
        },
        { status: 400 },
      );
    }

    try {
      const client = await getServiceClient();
      const space = await getConnectedSpace(parsed);
      const rooms = await space.fetchRooms();
      return Response.json({
        serviceDid: client.serviceDid,
        streamDid: parsed,
        roomCount: rooms.length,
        rooms,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: "ConnectFailed", message },
        { status: 500 },
      );
    }
  });
}
