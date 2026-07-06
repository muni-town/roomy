/**
 * XRPC: space.roomy.sync.getEvents (query).
 *
 * ADMIN-ONLY. Returns raw events from events.stream_events for a given stream,
 * after a cursor. Used by the discord-bridge to poll for new events after
 * receiving invalidation signals.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`). The router has
 * already verified the caller's inter-service JWT.
 */

import { openDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalInt, requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import { toBytes } from "@roomy-space/sdk";

interface GetEventsResult {
  events: Array<{
    idx: number;
    user: string;
    payload: { $bytes: string };
  }>;
  cursor: number;
}

export const getEventsHandler: QueryHandler<
  QueryParams,
  GetEventsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const streamDid = requireString(params, "streamDid");
  const cursor = optionalInt(params, "cursor", { min: 0, default: 0 });
  const limit = optionalInt(params, "limit", {
    min: 1,
    max: 100,
    default: 50,
  });

  const db = openDb();
  const rows = await db
    .query(
      `SELECT idx, user, payload
       FROM stream_events
       WHERE stream_id = ? AND idx > ?
       ORDER BY idx
       LIMIT ?`,
    )
    .all<{ idx: number; user: string; payload: Uint8Array }>(
      streamDid,
      cursor,
      limit,
    );

  const lastIdx = rows.length > 0 ? rows[rows.length - 1]!.idx : cursor;

  return {
    events: rows.map((r) => ({
      idx: r.idx,
      user: r.user,
      payload: toBytes(r.payload),
    })),
    cursor: lastIdx,
  };
};
