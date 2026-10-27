/**
 * XRPC: space.roomy.room.getMessages (query).
 *
 * Paginated message history. Cursor is a message entity ID (ULID); messages
 * older than the cursor are returned.
 */

import {
  openSpaceDbForEntity,
  resolveSpaceForEntity,
  tryOpenGlobalDb,
} from "../db/db.ts";
import { prioritiseLinksForRead } from "../embed/sweeper.ts";
import { selectMessages, type MessageDto } from "../queries/selectMessages.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import { withSpan } from "../telemetry/tracing.ts";

interface GetMessagesResult {
  messages: MessageDto[];
  cursor?: string;
}

/**
 * Instrumented entry point. Phases are split so the waterfall shows whether
 * latency is membership hydration, the message query, or read-driven embed
 * prioritisation — three very different fixes.
 */
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

  return withSpan(
    "space.roomy.room.getMessages",
    { "roomy.room_id": roomId, "roomy.limit": limit },
    async (span) => {

      const db = await withSpan("getMessages.openDb", {}, async (s) => {
        const opened = await openSpaceDbForEntity(roomId);
        s.setAttribute("roomy.db_found", opened !== null);
        return opened;
      });
      if (!db) {
        throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
      }
      await withSpan("getMessages.requireRead", {}, () =>
        requireRoomRead(db, roomId, userDid),
      );

      const { messages, nextCursor } = await withSpan(
        "getMessages.selectMessages",
        {},
        async (s) => {
          const result = await selectMessages(db, {
            kind: "room",
            roomId,
            limit,
            cursor,
          }, userDid, tryOpenGlobalDb());
          s.setAttribute("roomy.message_count", result.messages.length);
          return result;
        },
      );

      // Read-driven embed prioritisation: a user viewing this room is
      // actively waiting on these link cards, so jump any never-attempted
      // links ahead of the oldest-first backfill backlog (which can take
      // hours when dominated by erroring/timing-out links). Already-enriched
      // links are a no-op and transient-failed links keep their backoff (see
      // prioritiseLinksForRead).
      await withSpan("getMessages.prioritiseLinks", {}, async () => {
        const spaceDid = await resolveSpaceForEntity(roomId);
        if (spaceDid) await prioritiseLinksForRead(db, messages, spaceDid);
      });

      span.setAttribute("roomy.has_cursor", nextCursor != null);
      return stripNulls({ messages, cursor: nextCursor }) as GetMessagesResult;
    },
  );
};
