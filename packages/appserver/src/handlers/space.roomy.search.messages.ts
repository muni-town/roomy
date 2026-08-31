/**
 * XRPC: space.roomy.search.messages (query).
 *
 * Cross-space full-text message search backed by Qdrant (Phase 2 of
 * search-endpoints.md). The query is BM25-encoded to a sparse vector and
 * searched against the global `messages` collection, payload-filtered to
 * the caller's readable spaces (spaceId narrows the filter to one space).
 * Results are over-fetched (limit×3), hydrated via selectMessages
 * (`{ kind: "ids" }`), post-filtered by per-room read access, trimmed to
 * `limit`, and returned ranked best-match-first.
 *
 * Supports cursor-based pagination via `limit` and `cursor` (an opaque
 * offset token). One code path serves both per-space and cross-space.
 *
 * Reply context is denormalised: each hit that carries a `replyTo` gets a
 * `reply.message` (the fully hydrated replied-to message) attached when the
 * target resolves and the caller can read the target's room — the client
 * renders the preview without a getMessage fetch per hit, matching how
 * forwards embed their originals.
 *
 * Display names are denormalised too: each hit carries its space name/
 * avatar and room name/kind (resolved with two batched queries per
 * distinct space, in-process), so the client's context line renders
 * without getSpaceSummary/getRoomSummary round-trips.
 *
 * When Qdrant is not configured the endpoint returns 503 — search is
 * unavailable without the search service.
 */

import { createAccessMemo, roomAccess } from "../auth/access.ts";
import { openReadStateDb, openSpaceDb, openSpaceDbForEntity } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { selectJoinedSpaceDids } from "../queries/userSpaceMembership.ts";
import { selectMessages } from "../queries/selectMessages.ts";
import { encodeSparse } from "../search/bm25.ts";
import { getQdrantClient, searchMessages } from "../search/qdrantSearch.ts";
import { getQdrant } from "../qdrant.ts";
import { parseUserDid, requireSpaceRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import type { MessageDto } from "../queries/selectMessages.ts";
import { log } from "../log.ts";

/** Over-fetch factor: Qdrant returns limit×this candidates, we post-filter. */
const OVERFETCH = 3;

type SearchHit = MessageDto & {
  roomId?: string;
  spaceId?: string;
  reply?: SearchReply;
  spaceName?: string;
  spaceAvatar?: string;
  roomName?: string;
  roomKind?: string;
};

interface SearchMessagesResult {
  messages: SearchHit[];
  cursor?: string;
}

/** Denormalised reply context attached to a search hit. */
interface SearchReply {
  messageId: string;
  message?: MessageDto;
}

/** Strip the `space.roomy.` prefix from a room kind label (matches getRoomSummary). */
function stripLabel(label: string | null): string {
  if (!label) return "";
  const m = /^space\.roomy\.(.+)$/.exec(label);
  return m?.[1] ?? label;
}

export const searchMessagesHandler: QueryHandler<
  QueryParams,
  SearchMessagesResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const spaceId = optionalString(params, "spaceId") ?? null;
  const q = requireString(params, "q");
  const limit = optionalInt(params, "limit", { min: 1, max: 100, default: 50 })!;
  const cursor = optionalString(params, "cursor") ?? null;

  if (q.trim().length < 3) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Param q must be at least 3 characters",
    );
  }

  const client = getQdrantClient();
  if (!client) {
    throw new XrpcError(
      503,
      "Unavailable",
      "Message search is not configured on this server",
    );
  }

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }
  // Resolve the caller's readable space set. With spaceId the filter narrows
  // to that space (requireSpaceRead below enforces access); without it we
  // filter to the spaces the caller has joined.
  let spaceDids: string[];
  if (spaceId !== null) {
    spaceDids = [spaceId];
    await requireSpaceRead(openSpaceDb(spaceId), spaceId, userDid);
  } else if (userDid === null) {
    // Anonymous callers have no joined spaces to search.
    spaceDids = [];
  } else {
    spaceDids = await selectJoinedSpaceDids(openReadStateDb(), userDid);
  }
  if (spaceDids.length === 0) {
    return { messages: [] };
  }

  const window = limit * OVERFETCH;
  const offset = cursor !== null ? Number(cursor) : 0;
  const sparse = encodeSparse(q);
  let hits;
  try {
    hits = await searchMessages(client, {
      sparse,
      spaceDids,
      // Fixed window: Qdrant's sparse search returns tied points in an
      // order that DEPENDS on the requested limit (limit=1 → [m2],
      // limit=3 → [m1,m3,m2] for identical vectors), so re-fetching with a
      // different limit per page shifts the ordering and slices misalign.
      // A constant limit gives a stable ordering; the appserver slices the
      // window by cursor. The window is the searchable cap — pages beyond
      // it return fewer results and the cursor stops once it is exhausted.
      limit: window,
    });
  } catch (err) {
    // Surface the configured endpoint so a misconfigured QDRANT_URL is
    // diagnosable from the response (Bun's "Unable to connect" is generic —
    // it covers refused, TLS mismatch, and DNS failures alike).
    const config = getQdrant();
    const target = config ? `${config.url}${config.port !== undefined ? `:${config.port}` : ""}` : "unset";
    throw new XrpcError(
      500,
      "InternalServerError",
      `Qdrant search failed (target ${target}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Slice the window by cursor. A single Qdrant response never repeats a
  // point, so each page is distinct; the cursor continues while more
  // results remain in the fetched window and stops once it is exhausted.
  const windowHits = hits.slice(offset, offset + limit);

  // Hydrate per-space, keeping the hits' rank order. Qdrant returns ids;
  // SQLite provides the full message DTOs.
  const ranked: Array<{ message: MessageDto; roomId: string; spaceDid: string }> = [];
  const bySpace = new Map<string, string[]>();
  for (const h of windowHits) {
    const arr = bySpace.get(h.payload.spaceDid) ?? [];
    arr.push(h.messageId);
    bySpace.set(h.payload.spaceDid, arr);
  }
  const hydratedBySpace = new Map<string, Map<string, MessageDto>>();
  for (const [space, ids] of bySpace) {
    const db = openSpaceDb(space);
    try {
      const { messages } = await selectMessages(db, { kind: "ids", ids }, userDid ?? "");
      hydratedBySpace.set(space, new Map(messages.map((m) => [m.id, m])));
    } catch (err) {
      log.warn(`[search] selectMessages failed for space ${space}:`, err);
    }
  }
  for (const h of windowHits) {
    const m = hydratedBySpace.get(h.payload.spaceDid)?.get(h.messageId);
    if (m) ranked.push({ message: m, roomId: h.payload.roomId, spaceDid: h.payload.spaceDid });
  }

  // Resolve display names for the result context line. Two batched queries
  // per distinct space: the space's own name/avatar, then name/kind for
  // every room this window's hits live in (the same rows getSpaceSummary /
  // getRoomSummary would return — in-process, no extra HTTP round-trips).
  // Results are already read-authorized, so no additional access checks.
  const roomIdsBySpace = new Map<string, string[]>();
  for (const hit of ranked) {
    const arr = roomIdsBySpace.get(hit.spaceDid) ?? [];
    if (!arr.includes(hit.roomId)) arr.push(hit.roomId);
    roomIdsBySpace.set(hit.spaceDid, arr);
  }

  const spaceDisplay = new Map<string, { spaceName?: string; spaceAvatar?: string }>();
  const roomDisplay = new Map<string, { roomName?: string; roomKind?: string }>();
  for (const [space] of bySpace) {
    const db = openSpaceDb(space);
    const spaceRow = await db
      .query(
        `select ci.name as name, ci.avatar as avatar
           from comp_space cs
           left join comp_info ci on ci.entity = cs.entity
          where cs.entity = ?`,
      )
      .get<{ name: string | null; avatar: string | null }>(space);
    if (spaceRow) {
      spaceDisplay.set(space, {
        ...(spaceRow.name ? { spaceName: spaceRow.name } : {}),
        ...(spaceRow.avatar ? { spaceAvatar: spaceRow.avatar } : {}),
      });
    }

    const roomIds = roomIdsBySpace.get(space) ?? [];
    if (roomIds.length > 0) {
      const roomRows = await db
        .query(
          `select cr.entity as id, ci.name as name, cr.label as label
             from comp_room cr
             left join comp_info ci on ci.entity = cr.entity
            where cr.entity in (${roomIds.map(() => "?").join(",")})`,
        )
        .all<{ id: string; name: string | null; label: string | null }>(roomIds);
      for (const row of roomRows) {
        roomDisplay.set(row.id, {
          ...(row.name ? { roomName: row.name } : {}),
          ...(row.label ? { roomKind: stripLabel(row.label) } : {}),
        });
      }
    }
  }

  // Post-filter by per-room read access (membership alone is not enough —
  // rooms may restrict access), then trim to the requested limit. Each
  // result carries the room/space it was found in so cross-space search
  // clients can show context and link to the hit.
  const results: SearchHit[] = [];
  const memos = new Map<string, ReturnType<typeof createAccessMemo>>();
  for (const { message, roomId, spaceDid } of ranked) {
    if (results.length >= limit) break;
    let memo = memos.get(spaceDid);
    if (!memo) {
      memo = createAccessMemo();
      memos.set(spaceDid, memo);
    }
    const acc = await roomAccess(openSpaceDb(spaceDid), roomId, userDid, memo);
    if (!acc.canRead) continue;

    const result: SearchHit = {
      ...message,
      roomId,
      spaceId: spaceDid,
      ...spaceDisplay.get(spaceDid),
      ...roomDisplay.get(roomId),
    };
    // Denormalise the reply context. Only the message id rides along when
    // the target is unresolvable or unreadable — the client renders
    // "Reply unavailable" instead of fetching per hit.
    if (message.replyTo) {
      result.reply = { messageId: message.replyTo };
      try {
        const targetDb = await openSpaceDbForEntity(message.replyTo);
        if (targetDb) {
          let targetMemo = memos.get(spaceDid);
          if (!targetMemo) {
            targetMemo = createAccessMemo();
            memos.set(spaceDid, targetMemo);
          }
          const targetRow = await targetDb
            .query("select room from entities where id = ?")
            .get<{ room: string | null }>(message.replyTo);
          const targetRoom = targetRow?.room;
          if (targetRoom) {
            const targetAcc = await roomAccess(targetDb, targetRoom, userDid, targetMemo);
            if (targetAcc.canRead) {
              const { messages: targets } = await selectMessages(
                targetDb,
                { kind: "ids", ids: [message.replyTo] },
                userDid ?? "",
              );
              const target = targets[0];
              if (target) result.reply = { messageId: message.replyTo, message: target };
            }
          }
        }
      } catch (err) {
        log.warn(`[search] reply denormalisation failed for ${message.replyTo}:`, err);
      }
    }
    results.push(result);
  }

  const result: SearchMessagesResult = { messages: results };
  // Cursor semantics: offset + limit. Emit while more results remain in the
  // fetched window (this page didn't reach the end of it), or the window
  // itself was full AND this page still had content — one trailing cursor
  // that resolves to an empty page, so the client can discover the window
  // is exhausted. Once the window has been fully consumed (offset past the
  // end), stop: `hits.length === window` alone would emit a cursor on every
  // subsequent page forever.
  if (offset + limit < hits.length || (hits.length === window && offset < hits.length)) {
    result.cursor = String(offset + limit);
  }
  return stripNulls(result as unknown as Record<string, unknown>) as SearchMessagesResult;
};
