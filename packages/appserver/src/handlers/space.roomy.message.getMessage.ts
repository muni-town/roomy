/**
 * XRPC: space.roomy.message.getMessage (query).
 *
 * Single message by ID. The message's room is resolved first, then read
 * access on that room is enforced before assembling the message.
 */

import { type, UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { selectMessages, type MessageDto } from "../queries/selectMessages.ts";
import { requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

export const getMessageHandler: QueryHandler<QueryParams, MessageDto> = async (
  params: QueryParams,
  auth: AuthCtx,
) => {
  const userDid = UserDid(auth.did);
  if (userDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${userDid.summary}`,
    );
  }
  const messageId = requireString(params, "messageId");

  await hydrateUserMembership(userDid);

  const db = openDb();
  const row = db
    .query<
      { room: string | null },
      [string]
    >("select room from entities where id = ?")
    .get(messageId);

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

  requireRoomRead(db, row.room, userDid);

  const { messages } = selectMessages(db, { kind: "ids", ids: [messageId] }, userDid);
  const message = messages[0];
  if (!message) {
    throw new XrpcError(404, "NotFound", `Message not found: ${messageId}`);
  }
  return message;
};
