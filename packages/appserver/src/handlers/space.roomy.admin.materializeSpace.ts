/**
 * XRPC: space.roomy.admin.materializeSpace (query).
 *
 * Lazily creates (or returns the cached) `SpaceMaterializer` for the given
 * stream and reports its current state. With `wait=backfill`, awaits the
 * initial backfill before responding.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { StreamDid, type } from "@roomy-space/sdk";
import { requireAdmin } from "../admin.ts";
import { openDb } from "../db/db.ts";
import { readBackfilledTo } from "../materialization/SpaceMaterializer.ts";
import { getOrCreateMaterializer } from "../materialization/registry.ts";
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
  stats: {
    applied: number;
    materializerErrors: number;
    applyErrors: number;
    batches: number;
    gapCount: number;
    totalEventsDelivered: number;
  };
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

  const parsed = StreamDid(did);
  if (parsed instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `invalid stream DID: ${parsed.summary}`,
    );
  }

  const wait = params["wait"];
  const mat = await getOrCreateMaterializer(parsed);

  let backfillSettled = false;
  if (wait === "backfill") {
    await mat.backfillDone;
    backfillSettled = true;
  } else {
    // Best-effort: peek at whether the promise has already settled.
    mat.backfillDone.then(() => {
      backfillSettled = true;
    });
    await new Promise((r) => setImmediate(r));
  }

  await mat.drain();

  const db = openDb();
  const cursor = readBackfilledTo(db, parsed);
  const stats = mat.getStats();

  // Per-room event count diagnostic: compare appserver entity count vs
  // room_events count (which tracks every createMessage/room-event forwarded
  // to the Leaf module's materializer). A large discrepancy indicates missing
  // events due to subscription pagination issues.
  const rooms = db
    .query<
      { room_id: string; entity_count: number },
      [string]
    >(
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
    .all(parsed);

  return {
    streamDid: parsed,
    cursor,
    stats: {
      applied: stats.applied,
      materializerErrors: stats.materializerErrors,
      applyErrors: stats.applyErrors,
      batches: stats.batches,
      gapCount: mat.gapCount,
      totalEventsDelivered: mat.totalEventsDelivered,
    },
    backfillSettled,
    rooms: rooms.map((r) => ({
      roomId: r.room_id,
      entityCount: r.entity_count,
    })),
  };
};
