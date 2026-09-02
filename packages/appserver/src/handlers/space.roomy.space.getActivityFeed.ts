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
import { openReadStateDb, openSpaceDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import {
  selectActivityFeed,
  type ActivityFeedItem,
} from "../queries/activityFeed.ts";
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

  await hydrateUserMembership(userDid);
  const mainDb = openReadStateDb();

  // Per-request memo: the feed spans multiple spaces/rooms but each
  // (space, did) membership decision is reused across all items in that
  // space. Without the memo, each item's roomAccess re-queries the same
  // space-level flags.
  const memo = createAccessMemo();
  // If a specific space is requested, verify access against its per-space DB.
  if (spaceId) {
    await requireSpaceAccess(openSpaceDb(spaceId), spaceId, userDid, memo);
  }

  const { feed, cursor: nextCursor } = await selectActivityFeed(
    mainDb,
    userDid,
    { spaceId, limit, cursor },
  );

  // Filter by room-level read access: silently skip rooms the user can't read.
  // Each feed item carries its spaceId, so open that item's per-space DB.
  // Group items by space and batch the access checks per space (roomAccessMany)
  // instead of one roomAccess round-trip per item — the feed can span many
  // spaces, and each item was previously a separate per-space worker round-trip.
  const bySpace = new Map<string, string[]>();
  for (const item of feed) {
    const list = bySpace.get(item.spaceId) ?? [];
    list.push(item.threadId);
    bySpace.set(item.spaceId, list);
  }
  const accessByRoom = new Map<string, RoomAccess>();
  for (const [sid, threadIds] of bySpace) {
    const acc = await roomAccessMany(openSpaceDb(sid), threadIds, userDid, memo);
    for (const [roomId, a] of acc) accessByRoom.set(roomId, a);
  }
  const accessible = feed.filter((item) => accessByRoom.get(item.threadId)?.canRead ?? false);

  const result: GetActivityFeedResult = { feed: accessible };
  if (nextCursor) result.cursor = nextCursor;
  return result;
};