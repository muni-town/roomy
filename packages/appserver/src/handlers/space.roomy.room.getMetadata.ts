/**
 * XRPC: space.roomy.room.getMetadata (query).
 *
 * Room metadata plus the channel's recently active threads, which the caller
 * renders as the sidebar's thread list.
 */

import { createAccessMemo, roomAccessMany } from "../auth/access.ts";
import { openReadStateDb, openSpaceDbForEntity } from "../db/db.ts";
import { getChannelUnreadThreadCount, getReadPosition, getReadPositions, type ReadPosition } from "../queries/readPositions.ts";
import { listThreadActivity } from "../queries/threadActivity.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
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
  /** Number of engaged threads in this channel with unread messages. */
  unreadThreadCount: number;
  recentThreads: RecentThread[];
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
  // Per-request access memo: this handler calls roomAccess for the room
  // itself plus up to 20 recent threads, and each roomAccess call
  // internally checks isMember/isAdmin/isBanned/allowsPublicJoin on the
  // same parent space. Without the memo, that's ~5 redundant space-level
  // queries per thread (~100 per request). The memo collapses them to one
  // set per (space, did).
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
    // the read-gate filter and the canRead/canWrite fields below: a second
    // pass would double the per-thread SQL cost (~6 statements per thread,
    // ~120 per request for a full sidebar).
    //
    // The memo further collapses the per-thread space-level membership
    // checks (all threads share the same parent space) into a single set
    // of queries for the whole request.
    const candidates = threadActivity.filter((t) => t.id !== roomId);
    // One batched access pass across every candidate thread, rather than a
    // `roomAccess` call per thread. `roomAccess` is memoised but not batched:
    // each distinct thread is its own round-trip. With the `room_access`
    // projection the whole page collapses to one per-space read.
    const threadAccess = await roomAccessMany(
      db,
      candidates.map((t) => t.id),
      userDid,
      memo,
    );
    const accessible = candidates.filter(
      (t) => threadAccess.get(t.id)?.canRead ?? false,
    );
    const threadPositions = await getReadPositions(
      mainDb,
      userDid,
      accessible.map((t) => t.id),
    );
    for (const thread of accessible) {
      const access = threadAccess.get(thread.id)!;
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
