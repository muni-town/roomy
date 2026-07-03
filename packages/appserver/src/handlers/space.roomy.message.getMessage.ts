/**
 * XRPC: space.roomy.message.getMessage (query).
 *
 * Single message by ID. The message's room is resolved first, then read
 * access on that room is enforced before assembling the message.
 */

import { openDb } from "../db/db.ts";
import { prioritiseLinksForRead } from "../embed/sweeper.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { selectMessages, type MessageDto } from "../queries/selectMessages.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

export const getMessageHandler: QueryHandler<QueryParams, MessageDto> = async (
  params: QueryParams,
  auth: AuthCtx,
) => {
  const userDid = parseUserDid(auth);
  const messageId = requireString(params, "messageId");

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }

  const db = openDb();
  const row = await db
    .query("select room from entities where id = ?")
    .get<{ room: string | null }>(messageId);
  if (row === null) {
    throw new XrpcError(404, "NotFound", `Message not found: ${messageId}`);
  }
  if (!row.room) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Entity ${messageId} is not a message (no room)`,
    );
  }

  await requireRoomRead(db, row.room!, userDid);

  const { messages } = await selectMessages(db, { kind: "ids", ids: [messageId] }, userDid ?? undefined);
  const message = messages[0];
  if (!message) {
    throw new XrpcError(404, "NotFound", `Message not found: ${messageId}`);
  }

  // Read-driven embed prioritisation (see getMessages): jump this message's
  // never-attempted links ahead of the backfill backlog for the viewer.
  await prioritiseLinksForRead(db, [message]);

  return message;
};
