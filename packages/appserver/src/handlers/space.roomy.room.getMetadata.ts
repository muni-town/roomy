/**
 * XRPC: space.roomy.room.getMetadata (query).
 *
 * Room metadata plus the channel's thread-unread badge count.
 */

import { createAccessMemo } from "../auth/access.ts";
import { openReadStateDb, openSpaceDbForEntity } from "../db/db.ts";
import { getChannelUnreadThreadCount, getReadPosition, type ReadPosition } from "../queries/readPositions.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetRoomMetadataResult {
  name?: string;
  kind: string;
  spaceId: string;
  defaultAccess: "readwrite" | "read" | "none";
  canRead: boolean;
  canWrite: boolean;
  lastRead?: string;
  unreadCount: number;
  /** Number of engaged threads in this channel with unread messages. */
  unreadThreadCount: number;
}

export const getRoomMetadataHandler: QueryHandler<
  QueryParams,
  GetRoomMetadataResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const roomId = requireString(params, "roomId");

  const db = await openSpaceDbForEntity(roomId);
  if (!db) {
    throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
  }
  const mainDb = openReadStateDb();
  // Per-request access memo: this handler and the channel-unread-thread
  // count below both check isMember/isAdmin/isBanned/allowsPublicJoin on
  // the same parent space. The memo collapses them to one set per
  // (space, did).
  const memo = createAccessMemo();
  const access = await requireRoomRead(db, roomId, userDid, memo);

  const row = await db
    .query(
      `select ci.name as name, cr.label as label
         from comp_room cr
         left join comp_info ci on ci.entity = cr.entity
        where cr.entity = ?`,
    )
    .get<{ name: string | null; label: string | null }>(roomId);

  let pos: ReadPosition;
  let unreadThreadCount = 0;
  if (userDid !== null) {
    pos = await getReadPosition(mainDb, userDid, roomId);
    // Channel pages show a Threads-tab badge: engaged threads in this
    // channel with unreads. Thread rooms have no sibling-thread badge.
    if (access.parentChannelId === null) {
      unreadThreadCount = await getChannelUnreadThreadCount(
        mainDb,
        db,
        roomId,
        userDid,
        memo,
      );
    }
  } else {
    pos = { unreadCount: 0, lastRead: null };
  }
  return stripNulls({
    name: row?.name ?? null,
    kind: stripLabel(row?.label ?? null),
    spaceId: access.spaceId ?? "",
    parentChannelId: access.parentChannelId,
    defaultAccess: access.defaultAccess,
    canRead: access.canRead,
    canWrite: access.canWrite,
    lastRead: (pos.lastRead as string | null) ?? null,
    unreadCount: pos.unreadCount,
    unreadThreadCount,
  }) as GetRoomMetadataResult;
};

/**
 * Convert SDK room labels (`space.roomy.channel`, `space.roomy.thread`,
 * `space.roomy.page`) to the short `kind` strings the spec promises.
 */
function stripLabel(label: string | null): string {
  if (!label) return "";
  const m = /^space\.roomy\.(.+)$/.exec(label);
  return m?.[1] ?? label;
}
