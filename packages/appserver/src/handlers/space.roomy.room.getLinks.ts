/**
 * XRPC: space.roomy.room.getLinks (query).
 *
 * Paginated, newest-first, URL-deduped index of every link shared in a single
 * room, filtered by the caller's read access (the room itself must be
 * readable — a links view is a cross-room read, so the caller's read access
 * is enforced here exactly as for `room.getThreads`).
 *
 * Each link returns its room id (the real room, not the message id — the
 * two-hop join the embed sweeper's invalidation uses is the same here), the
 * message that shared it, and its enriched card (null-safe — absent when the
 * embed service had no data). Each link also carries `timestamp` — when it was
 * shared, derived from the ordering key (absent when not derivable).
 *
 * Supports cursor-based pagination via `limit` and `cursor` params.
 */

import { createAccessMemo, roomAccess } from "../auth/access.ts";
import { openSpaceDbForEntity } from "../db/db.ts";
import { cursorForRow, dedupeLinks, linkTimestamp, listLinks } from "../queries/links.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import { withSpan } from "../telemetry/tracing.ts";

interface LinkRow {
  url: string;
  roomId: string;
  messageId: string;
  /** When the link was shared (ISO 8601 UTC), absent when not derivable. */
  timestamp?: string;
  /** Enriched card data (EmbedV1 JSON), absent when the enricher had no data. */
  embed?: Record<string, unknown>;
}

interface GetRoomLinksResult {
  links: LinkRow[];
  cursor?: string;
}

export const getRoomLinksHandler: QueryHandler<
  QueryParams,
  GetRoomLinksResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const roomId = requireString(params, "roomId");
  const limit = optionalInt(params, "limit", { min: 1, max: 100, default: 50 })!;
  const cursor = optionalString(params, "cursor") ?? null;

  return withSpan(
    "space.roomy.room.getLinks",
    { "roomy.room_id": roomId, "roomy.limit": limit },
    async (span) => {
      const db = await withSpan("getLinks.openDb", {}, async () =>
        openSpaceDbForEntity(roomId),
      );
      if (!db) {
        throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
      }
      const memo = createAccessMemo();
      await withSpan("getLinks.requireRead", {}, () =>
        requireRoomRead(db, roomId, userDid, memo),
      );

      const { links: raw, hasMore } = await withSpan(
        "getLinks.list",
        {},
        () => listLinks(db, { kind: "room", roomId }, limit, cursor),
      );

      // A single-room read: the room is already verified readable, so no
      // per-link access check is needed. Dedup attachment-encoded duplicates
      // of the same URL (see dedupeLinks).
      const deduped = dedupeLinks(raw);

      let nextCursor: string | null = null;
      if (hasMore && deduped.length > 0) {
        nextCursor = cursorForRow(deduped[deduped.length - 1]!);
      }

      const links: LinkRow[] = deduped.map((r) => {
        const link: LinkRow = {
          url: r.url,
          roomId: r.room_id,
          messageId: r.message_id,
        };
        const timestamp = linkTimestamp(r.sort_key);
        if (timestamp !== undefined) link.timestamp = timestamp;
        if (r.embed_json !== null) {
          link.embed = JSON.parse(r.embed_json) as Record<string, unknown>;
        }
        return link;
      });

      span.setAttribute("roomy.link_count", links.length);
      span.setAttribute("roomy.has_cursor", nextCursor != null);
      const result: GetRoomLinksResult = { links };
      if (nextCursor) result.cursor = nextCursor;
      return stripNulls(result as unknown as Record<string, unknown>) as unknown as GetRoomLinksResult;
    },
  );
};
