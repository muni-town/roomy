/**
 * XRPC: space.roomy.admin.materializeSpace (query).
 *
 * Reports the current materialization state for a stream by reading
 * cursor from `events.stream_state` and backfill status from
 * `comp_space.backfilled_to`.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { StreamDid } from "@roomy-space/sdk";
import { requireAdmin } from "../admin.ts";
import { openDb } from "../db/db.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface RoomEventCount {
  roomId: string;
  entityCount: number;
}

interface MaterializeSpaceResult {
  streamDid: string;
  cursor: number;
  backfillSettled: boolean;
  /** Per-room entity counts — useful for diagnosing missing events by room. */
  rooms?: RoomEventCount[];
}

export const materializeSpaceHandler: QueryHandler<
  QueryParams,
  MaterializeSpaceResult
> = async (params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const did = params["did"];
  if (typeof did !== "string" || did === "") {
    throw new XrpcError(400, "InvalidRequest", "missing 'did' query parameter");
  }

  const parsed = StreamDid.assert(did);

  const db = openDb();

  // Read cursor from events.stream_state
  const cursorRow = await db
    .query("select latest_event from events.stream_state where stream_id = ?")
    .get<{ latest_event: number }>(parsed);
  const cursor = cursorRow?.latest_event ?? 0;

  // Read backfill status from comp_space
  const backfillRow = await db
    .query("select backfilled_to from comp_space where entity = ?")
    .get<{ backfilled_to: number | null }>(parsed);
  const backfillSettled = backfillRow != null && backfillRow.backfilled_to != null;

  // Per-room event count diagnostic: compare appserver entity count vs
  // room_events count (which tracks every createMessage/room-event forwarded
  // to the Leaf module's materializer). A large discrepancy indicates missing
  // events due to subscription pagination issues.
  const rooms = await db
    .query(
      `select
         e.room as room_id,
         count(*) as entity_count
       from entities e
       join comp_room cr on cr.entity = e.room
       where e.room is not null
         and e.stream_id = ?
       group by e.room
       order by entity_count desc
       limit 200`,
    )
    .all<{ room_id: string; entity_count: number }>(parsed);

  return {
    streamDid: parsed,
    cursor,
    backfillSettled,
    rooms: rooms.map((r): RoomEventCount => ({
      roomId: r.room_id,
      entityCount: r.entity_count,
    })),
  };
};
