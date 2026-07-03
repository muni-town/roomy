/**
 * XRPC: space.roomy.room.getMetadata (query).
 *
 * Room metadata + recently active threads (replaces the separate
 * getLinkedRooms query). Stage-1: unread fields are 0/null.
 */

import { roomAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { getReadPosition, getReadPositions, type ReadPosition } from "../queries/readPositions.ts";
import { listThreadActivity } from "../queries/threadActivity.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface RecentThread {
  id: string;
  name?: string;
  canRead: boolean;
  canWrite: boolean;
  unreadCount: number;
  lastRead?: string;
}

interface GetRoomMetadataResult {
  name?: string;
  kind: string;
  spaceId: string;
  defaultAccess: "readwrite" | "read" | "none";
  canRead: boolean;
  canWrite: boolean;
  lastRead?: string;
  unreadCount: number;
  recentThreads: RecentThread[];
}

export const getRoomMetadataHandler: QueryHandler<
  QueryParams,
  GetRoomMetadataResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const roomId = requireString(params, "roomId");

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }

  const db = openDb();
  const access = await requireRoomRead(db, roomId, userDid);

  const row = await db
    .query(
      `select ci.name as name, cr.label as label
         from comp_room cr
         left join comp_info ci on ci.entity = cr.entity
        where cr.entity = ?`,
    )
    .get<{ name: string | null; label: string | null }>(roomId);

  // Recent threads: scope is this channel for channels, the parent channel
  // for threads (so we get sibling threads). Falls back to the room itself
  // when there's no parent (which yields an empty list).
  const channelForThreads = access.parentChannelId ?? roomId;
  const threadActivity = (await listThreadActivity(
    db,
    { kind: "channel", channelId: channelForThreads },
    20,
  )) ?? [];

  const recentThreads: RecentThread[] = [];
  if (userDid !== null) {
    const threadRoomIds = threadActivity
      .filter((t) => t.id !== roomId);
    const threadAccessResults = await Promise.all(
      threadRoomIds.map((t) => roomAccess(db, t.id, userDid)),
    );
    const accessibleThreadRoomIds = threadRoomIds.filter((_, i) => threadAccessResults[i]?.canRead ?? false);
    const threadPositions = await getReadPositions(
      db,
      userDid,
      accessibleThreadRoomIds.map((t) => t.id),
    );
    for (const t of accessibleThreadRoomIds) {
      const acc = await roomAccess(db, t.id, userDid);
      const pos = threadPositions.get(t.id);
      recentThreads.push(stripNulls({
        id: t.id,
        name: t.name,
        canRead: acc.canRead,
        canWrite: acc.canWrite,
        unreadCount: pos?.unreadCount ?? 0,
        lastRead: (pos?.lastRead as string | null) ?? null,
      }) as RecentThread);
    }
  }

  let pos: ReadPosition;
  if (userDid !== null) {
    pos = await getReadPosition(db, userDid, roomId);
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
    recentThreads,
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
