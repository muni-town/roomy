/**
 * XRPC: space.roomy.room.getMessages (query).
 *
 * Paginated message history. Cursor is a message entity ID (ULID); messages
 * older than the cursor are returned.
 */

import { type, UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { selectMessages, type MessageDto } from "../queries/selectMessages.ts";
import { requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
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
  const userDid = UserDid(auth.did);
  if (userDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${userDid.summary}`,
    );
  }
  const roomId = requireString(params, "roomId");
  const limit = optionalInt(params, "limit", {
    min: 1,
    max: 100,
    default: 50,
  })!;
  const cursor = optionalString(params, "cursor") ?? null;

  await hydrateUserMembership(userDid);

  const db = openDb();
  requireRoomRead(db, roomId, userDid);

  const { messages, nextCursor } = selectMessages(db, {
    kind: "room",
    roomId,
    limit,
    cursor,
  }, userDid);

  return stripNulls({ messages, cursor: nextCursor }) as GetMessagesResult;
};
