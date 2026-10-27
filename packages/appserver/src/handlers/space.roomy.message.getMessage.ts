/**
 * XRPC: space.roomy.message.getMessage (query).
 *
 * Single message by ID. The message's room is resolved first, then read
 * access on that room is enforced before assembling the message.
 *
 * This is the one route that can return a hidden author's body. Every other
 * message-returning route — the room timeline, search, the activity feed, the
 * live frames, the counters, push — redacts for every caller, admins included.
 * Here, and only here, a viewer who holds the space's admin edge may read a
 * message whose author they blocked *themselves*: an exception narrow enough
 * to state in two clauses, and a read that changes nothing (no row, no audit,
 * no state anywhere).
 */

import { isAdmin } from "../auth/access.ts";
import {
  openSpaceDbForEntity,
  resolveSpaceForEntity,
  tryOpenGlobalDb,
} from "../db/db.ts";
import { prioritiseLinksForRead } from "../embed/sweeper.ts";
import { selectMessages, type MessageDto } from "../queries/selectMessages.ts";
import { blocks } from "../queries/userBlocks.ts";
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


  const db = await openSpaceDbForEntity(messageId);
  if (!db) {
    throw new XrpcError(404, "NotFound", `Message not found: ${messageId}`);
  }
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

  const { messages } = await selectMessages(
    db,
    { kind: "ids", ids: [messageId] },
    userDid,
    tryOpenGlobalDb(),
  );
  let message = messages[0];
  if (!message) {
    throw new XrpcError(404, "NotFound", `Message not found: ${messageId}`);
  }

  // A tombstone is opened only for a viewer who satisfies both clauses: the
  // author is hidden from them *because they placed the block* — not because
  // the author blocked them, which grants nothing — and they hold the admin
  // edge on the space that materialised the room. The per-space edge, never
  // the `APPSERVER_ADMIN_DIDS` service allowlist: the two are unrelated, and a
  // check written against the wrong one would let every service identity
  // unmask every block it holds.
  if (message.blocked === true && userDid !== null && message.authorDid !== "") {
    const spaceDid = (await blocks(userDid)).has(message.authorDid)
      ? await resolveSpaceForEntity(row.room)
      : null;
    if (spaceDid !== null && (await isAdmin(db, spaceDid, userDid))) {
      // Assembled with an empty hidden set: the row is the viewer's own
      // hidden author, and this one fetch returns it whole. The `blocked`
      // flag is put back afterwards — the author is still blocked, and a
      // revealed row that did not say so would be indistinguishable from an
      // ordinary message.
      const { messages: revealed } = await selectMessages(
        db,
        { kind: "ids", ids: [messageId] },
        userDid,
        tryOpenGlobalDb(),
        [],
      );
      const full = revealed[0];
      if (full) message = { ...full, blocked: true };
    }
  }

  // Read-driven embed prioritisation (see getMessages): jump this message's
  // unresolved links ahead of the backfill backlog for the viewer, and queue
  // the tile half of any link whose tile was never resolved.
  const spaceDid = await resolveSpaceForEntity(message.id);
  if (spaceDid) await prioritiseLinksForRead(db, [message], spaceDid);

  return message;
};
