/**
 * XRPC: space.roomy.room.getMetadata (query).
 *
 * Room metadata + recently active threads (replaces the separate
 * getLinkedRooms query). Stage-1: unread fields are 0/null.
 */

import { type, UserDid } from "@roomy-space/sdk";
import { roomAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { getReadPosition, getReadPositions } from "../queries/readPositions.ts";
import { listThreadActivity } from "../queries/threadActivity.ts";
import { requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
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
  const userDid = UserDid(auth.did);
  if (userDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${userDid.summary}`,
    );
  }
  const roomId = requireString(params, "roomId");

  await hydrateUserMembership(userDid);

  const db = openDb();
  const access = requireRoomRead(db, roomId, userDid);

  const row = db
    .query<{ name: string | null; label: string | null }, [string]>(
      `select ci.name as name, cr.label as label
         from comp_room cr
         left join comp_info ci on ci.entity = cr.entity
        where cr.entity = ?`,
    )
    .get(roomId);

  // Recent threads: scope is this channel for channels, the parent channel
  // for threads (so we get sibling threads). Falls back to the room itself
  // when there's no parent (which yields an empty list).
  const channelForThreads = access.parentChannelId ?? roomId;
  const threadActivity = listThreadActivity(
    db,
    { kind: "channel", channelId: channelForThreads },
    20,
  );

  const recentThreads: RecentThread[] = [];
  const threadRoomIds = threadActivity
    .filter((t) => t.id !== roomId)
    .filter((t) => roomAccess(db, t.id, userDid).canRead);
  const threadPositions = getReadPositions(
    db,
    userDid,
    threadRoomIds.map((t) => t.id),
  );
  for (const t of threadRoomIds) {
    const acc = roomAccess(db, t.id, userDid);
    const pos = threadPositions.get(t.id);
    recentThreads.push(stripNulls({
      id: t.id,
      name: t.name,
      canRead: acc.canRead,
      canWrite: acc.canWrite,
      unreadCount: pos?.unreadCount ?? 0,
      lastRead: pos?.lastRead ?? null,
    }) as RecentThread);
  }

  const pos = getReadPosition(db, userDid, roomId);
  return stripNulls({
    name: row?.name ?? null,
    kind: stripLabel(row?.label ?? null),
    spaceId: access.spaceId ?? "",
    defaultAccess: access.defaultAccess,
    canRead: access.canRead,
    canWrite: access.canWrite,
    lastRead: pos.lastRead,
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
