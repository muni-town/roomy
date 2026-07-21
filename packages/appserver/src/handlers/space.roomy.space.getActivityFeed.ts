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

import { createAccessMemo, roomAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
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
  const db = openDb();

  // Resolve the caller's personal stream DID for joined-spaces filtering.
  const personalStreamRow = await db
    .query(
      "select personal_stream_did from comp_user_personal_stream where user_did = ?",
    )
    .get<{ personal_stream_did: string }>(userDid);

  if (!personalStreamRow) {
    // No personal stream resolved — user isn't a member of any space yet.
    const result: GetActivityFeedResult = { feed: [] };
    return result;
  }

  // Per-request memo: the feed spans multiple spaces/rooms but each
  // (space, did) membership decision is reused across all items in that
  // space. Without the memo, each item's roomAccess re-queries the same
  // space-level flags.
  const memo = createAccessMemo();
  // If a specific space is requested, verify access.
  if (spaceId) {
    await requireSpaceAccess(db, spaceId, userDid, memo);
  }

  const { feed, cursor: nextCursor } = await selectActivityFeed(
    db,
    userDid,
    personalStreamRow.personal_stream_did as string,
    { spaceId, limit, cursor },
  );

  // Filter by room-level read access: silently skip rooms the user can't read.
  const accessResults = await Promise.all(
    feed.map((item) => roomAccess(db, item.threadId, userDid, memo)),
  );
  const accessible = feed.filter((_, i) => accessResults[i]?.canRead ?? false);

  const result: GetActivityFeedResult = { feed: accessible };
  if (nextCursor) result.cursor = nextCursor;
  return result;
};