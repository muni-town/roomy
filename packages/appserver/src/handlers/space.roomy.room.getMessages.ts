/**
 * XRPC: space.roomy.room.getMessages (query).
 *
 * Paginated message history. Cursor is a message entity ID (ULID); messages
 * older than the cursor are returned.
 */

import { openDb } from "../db/db.ts";
import { prioritiseLinksForRead } from "../embed/sweeper.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { selectMessages, type MessageDto } from "../queries/selectMessages.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetMessagesResult {
  messages: MessageDto[];
  cursor?: string;
}

export const getMessagesHandler: QueryHandler<
  QueryParams,
  GetMessagesResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const roomId = requireString(params, "roomId");
  const limit = optionalInt(params, "limit", {
    min: 1,
    max: 100,
    default: 50,
  });
  const cursor = optionalString(params, "cursor") ?? null;

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }

  const db = openDb();
  requireRoomRead(db, roomId, userDid);

  const { messages, nextCursor } = selectMessages(db, {
    kind: "room",
    roomId,
    limit,
    cursor,
  }, userDid ?? "");

  // Read-driven embed prioritisation: a user viewing this room is actively
  // waiting on these link cards, so jump any never-attempted links ahead of
  // the oldest-first backfill backlog (which can take hours when dominated
  // by erroring/timing-out links). Already-enriched links are a no-op and
  // transient-failed links keep their backoff (see prioritiseLinksForRead).
  prioritiseLinksForRead(db, messages);

  return stripNulls({ messages, cursor: nextCursor }) as GetMessagesResult;
};
