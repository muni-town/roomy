/**
 * XRPC: space.roomy.space.getLinks (query).
 *
 * Paginated, newest-first, URL-deduped index of every link shared anywhere in
 * a space, filtered by the caller's read access: a link whose containing room
 * the caller cannot read is omitted (a links view is a cross-room read and
 * must not leak a room the caller cannot read). The caller must have read
 * access to the space itself.
 *
 * Each link returns its room id, the message that shared it, and its enriched
 * card (null-safe — absent when the embed service had no data). Each link also
 * carries `timestamp` — when it was shared, derived from the ordering key
 * (absent when not derivable). A URL shared in two readable rooms appears once
 * (the newest occurrence), so the space index shows each URL a single time.
 *
 * Supports cursor-based pagination via `limit` and `cursor` params.
 */

import { createAccessMemo, roomAccessMany } from "../auth/access.ts";
import { openSpaceDb } from "../db/db.ts";
import { cursorForRow, dedupeLinks, linkTimestamp, listLinks } from "../queries/links.ts";
import { parseUserDid, requireSpaceRead } from "../xrpc/authGuards.ts";
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

interface GetSpaceLinksResult {
  links: LinkRow[];
  cursor?: string;
}

export const getSpaceLinksHandler: QueryHandler<
  QueryParams,
  GetSpaceLinksResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const spaceId = requireString(params, "spaceId");
  const limit = optionalInt(params, "limit", { min: 1, max: 100, default: 50 })!;
  const cursor = optionalString(params, "cursor") ?? null;

  return withSpan(
    "space.roomy.space.getLinks",
    { "roomy.space_id": spaceId, "roomy.limit": limit },
    async (span) => {
      const db = openSpaceDb(spaceId);
      const memo = createAccessMemo();
      await withSpan("getLinks.requireRead", {}, () =>
        requireSpaceRead(db, spaceId, userDid, memo),
      );

      const { links: raw, hasMore } = await withSpan(
        "getLinks.list",
        {},
        () => listLinks(db, { kind: "space", spaceId }, limit, cursor),
      );

      // Batch-resolve read access for every distinct room the page touches
      // (the batched pass — not one roomAccess round-trip per link — mirrors
      // how space.getThreads resolves the index board). A link whose room the
      // caller cannot read is dropped before dedup, so a URL seen in a readable
      // room is never suppressed in favour of an unreadable duplicate.
      const roomIds = [...new Set(raw.map((r) => r.room_id))];
      const accessByRoom =
        roomIds.length > 0
          ? await withSpan("getLinks.roomAccess", {}, () =>
              roomAccessMany(db, roomIds, userDid, memo),
            )
          : new Map<string, { canRead: boolean }>();

      const readable = raw.filter(
        (r) => accessByRoom.get(r.room_id)?.canRead ?? false,
      );
      const deduped = dedupeLinks(readable);

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
      const result: GetSpaceLinksResult = { links };
      if (nextCursor) result.cursor = nextCursor;
      return stripNulls(result as unknown as Record<string, unknown>) as unknown as GetSpaceLinksResult;
    },
  );
};
