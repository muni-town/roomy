/**
 * XRPC: space.roomy.room.getRoomSummary (query).
 *
 * Lightweight read of a room's display fields (name, kind, spaceId) only.
 * This is the badge-enrichment counterpart to `space.roomy.room.getMetadata`:
 * it skips `listThreadActivity`, per-thread `roomAccess`, and read positions
 * that make `getMetadata` run ~250 SQL statements per call. A badge rendering
 * an internal link only needs a label and a thread/channel kind icon, so
 * this handler returns just that — one SQL row plus the single
 * `requireRoomRead` access check.
 */

import { openDb } from "../db/db.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetRoomSummaryResult {
  name?: string;
  kind: string;
  spaceId: string;
}

function stripLabel(label: string | null): string {
  if (!label) return "";
  const m = /^space\.roomy\.(.+)$/.exec(label);
  return m?.[1] ?? label;
}

export const getRoomSummaryHandler: QueryHandler<
  QueryParams,
  GetRoomSummaryResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const roomId = requireString(params, "roomId");

  const db = openDb();
  // Single access check — no memo needed (no loop). requireRoomRead throws
  // 404/403 as appropriate.
  const access = await requireRoomRead(db, roomId, userDid);

  const row = await db
    .query(
      `select ci.name as name, cr.label as label
         from comp_room cr
         left join comp_info ci on ci.entity = cr.entity
        where cr.entity = ?`,
    )
    .get<{ name: string | null; label: string | null }>(roomId);

  return stripNulls({
    name: row?.name ?? null,
    kind: stripLabel(row?.label ?? null),
    spaceId: access.spaceId ?? "",
  }) as GetRoomSummaryResult;
};