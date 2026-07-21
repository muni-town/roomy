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
  const { threads: threadActivity } = (await listThreadActivity(
    db,
    { kind: "channel", channelId: channelForThreads },
    20,
  ));

  const recentThreads: RecentThread[] = [];
  if (userDid !== null) {
    // Compute roomAccess once per thread and reuse the result for both
    // the read-gate filter and the canRead/canWrite fields below. The
    // previous code discarded the first pass and recomputed roomAccess
    // for every accessible thread — doubling the per-thread SQL cost
    // (~6 statements per thread, ~120 per request for a full sidebar).
    const candidates = threadActivity.filter((t) => t.id !== roomId);
    const accessByIndex = await Promise.all(
      candidates.map((t) => roomAccess(db, t.id, userDid)),
    );
    const accessible = candidates
      .map((t, i) => ({ thread: t, access: accessByIndex[i]! }))
      .filter(({ access }) => access.canRead);
    const threadPositions = await getReadPositions(
      db,
      userDid,
      accessible.map(({ thread }) => thread.id),
    );
    for (const { thread, access } of accessible) {
      const pos = threadPositions.get(thread.id);
      recentThreads.push(stripNulls({
        id: thread.id,
        name: thread.name,
        canRead: access.canRead,
        canWrite: access.canWrite,
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
