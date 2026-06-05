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

import { type, UserDid } from "@roomy-space/sdk";
import { roomAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import {
  selectActivityFeed,
  type ActivityFeedItem,
} from "../queries/activityFeed.ts";
import { requireSpaceAccess } from "../xrpc/authGuards.ts";
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
  const userDid = UserDid(auth.did);
  if (userDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${userDid.summary}`,
    );
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
  const personalStreamRow = db
    .query<{ personal_stream_did: string }, [string]>(
      "select personal_stream_did from comp_user_personal_stream where user_did = ?",
    )
    .get(userDid);

  if (!personalStreamRow) {
    // No personal stream resolved — user isn't a member of any space yet.
    const result: GetActivityFeedResult = { feed: [] };
    return result;
  }

  // If a specific space is requested, verify access.
  if (spaceId) {
    requireSpaceAccess(db, spaceId, userDid);
  }

  const { feed, cursor: nextCursor } = selectActivityFeed(
    db,
    userDid,
    personalStreamRow.personal_stream_did,
    { spaceId, limit, cursor },
  );

  // Filter by room-level read access: silently skip rooms the user can't read.
  // This mirrors the pattern in getSpaceThreads / getRoomThreads.
  const accessible = feed.filter((item) => {
    const acc = roomAccess(db, item.threadId, userDid);
    return acc.canRead;
  });

  const result: GetActivityFeedResult = { feed: accessible };
  if (nextCursor) result.cursor = nextCursor;
  return result;
};