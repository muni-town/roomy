/**
 * XRPC: space.roomy.sync.getEvents (query).
 *
 * Returns raw events from events.stream_events for a given stream, after a
 * cursor. Used by the discord-bridge to poll for new events after receiving
 * invalidation signals.
 */

import { openDb } from "../db/db.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalInt, requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface RawEvent {
  idx: number;
  user: string;
  payload: Uint8Array;
}

interface GetEventsResult {
  events: Array<{
    idx: number;
    user: string;
    payload: Uint8Array;
  }>;
  cursor: number;
}

export const getEventsHandler: QueryHandler<
  QueryParams,
  GetEventsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  const streamDid = requireString(params, "streamDid");
  const limit = optionalInt(params, "limit", {
    min: 1,
    max: 100,
    default: 50,
  });
  const cursor = optionalInt(params, "cursor", {
    min: 0,
    default: -1,
  });

  const db = openDb();
  const events = await db
    .query<RawEvent>(
      "select idx, user, payload from events.stream_events where stream_id = ? and idx > ? order by idx limit ?",
    )
    .all(streamDid, cursor, limit);

  const lastIdx = events.length > 0 ? events[events.length - 1].idx : cursor;

  return { events, cursor: lastIdx };
};
