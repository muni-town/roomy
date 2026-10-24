/**
 * XRPC: space.roomy.space.getActivityFeed (query).
 *
 * Returns a paginated feed of recent activity across the user's joined spaces
 * (or a single space if `spaceId` is provided). One item per room, containing
 * up to 5 recent messages. Filtered by the caller's room-level read access.
 *
 * Items are materialized on createMessage events into the `activity_item` table
 * and joined with full message data at query time.
 */

import { createAccessMemo, roomAccessMany, type RoomAccess } from "../auth/access.ts";
import { openReadStateDb, openSpaceDb, tryOpenGlobalDb } from "../db/db.ts";
import {
  mapBounded,
  selectActivityFeed,
  SPACE_FANOUT_CONCURRENCY,
  type ActivityFeedItem,
} from "../queries/activityFeed.ts";
import { withSpan } from "../telemetry/tracing.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalInt, optionalString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetActivityFeedResult {
  feed: ActivityFeedItem[];
  cursor?: string;
}

export const getActivityFeedHandler: QueryHandler<
  QueryParams,
  GetActivityFeedResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  const spaceId = optionalString(params, "spaceId");
  const limit = optionalInt(params, "limit", {
    min: 1,
    max: 100,
    default: 50,
  })!;
  const cursor = optionalString(params, "cursor") ?? null;

  // The feed fans out over every joined space, so the span carries the space
  // count the fan-out actually covered — the number that explains the
  // request's duration — alongside the page size.
  return withSpan(
    "space.roomy.space.getActivityFeed",
    {
      "roomy.limit": limit,
      ...(spaceId ? { "roomy.space_id": spaceId } : {}),
    },
    async (span) => {
      const mainDb = openReadStateDb();

      // Per-request memo: the feed spans multiple spaces/rooms but each
      // (space, did) membership decision is reused across all items in that
      // space. Without the memo, each item's roomAccess re-queries the same
      // space-level flags.
      const memo = createAccessMemo();

      const { feed, cursor: nextCursor, spaceCount } = await withSpan(
        "getActivityFeed.select",
        {},
        async () => {
          // If a specific space is requested, verify access against its
          // per-space DB.
          if (spaceId) {
            await requireSpaceAccess(openSpaceDb(spaceId), spaceId, userDid, memo);
          }
          return selectActivityFeed(
            mainDb,
            userDid,
            { spaceId, limit, cursor },
            tryOpenGlobalDb(),
          );
        },
      );
      span.setAttribute("roomy.space_count", spaceCount);

      // Filter by room-level read access: silently skip rooms the user can't
      // read. Each feed item carries its spaceId, so open that item's per-space
      // DB. Group items by space and batch the access checks per space
      // (roomAccessMany) instead of one roomAccess round-trip per item — the
      // feed can span many spaces, so a per-item check would cost a worker
      // round-trip per space per item. The per-space checks are independent, so
      // they run concurrently and bounded, like the feed's own fan-out.
      const bySpace = new Map<string, string[]>();
      for (const item of feed) {
        const list = bySpace.get(item.spaceId) ?? [];
        list.push(item.threadId);
        bySpace.set(item.spaceId, list);
      }
      const accessGroups = await withSpan("getActivityFeed.roomAccess", {}, () =>
        mapBounded([...bySpace], SPACE_FANOUT_CONCURRENCY, async ([sid, threadIds]) =>
          roomAccessMany(openSpaceDb(sid), threadIds, userDid, memo),
        ),
      );
      const accessByRoom = new Map<string, RoomAccess>();
      for (const acc of accessGroups) {
        for (const [roomId, a] of acc) accessByRoom.set(roomId, a);
      }
      const accessible = feed.filter((item) => accessByRoom.get(item.threadId)?.canRead ?? false);
      span.setAttribute("roomy.visible_item_count", accessible.length);

      const result: GetActivityFeedResult = { feed: accessible };
      if (nextCursor) result.cursor = nextCursor;
      return result;
    },
  );
};