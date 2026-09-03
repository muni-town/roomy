/**
 * Helper to look up pre-computed unread counts from the readstate database.
 *
 * All unread data is read directly from the `unread_count` column — no
 * COUNT(*) against entities. This is O(1) per room.
 */

import { createAccessMemo, roomAccessMany, type AccessMemo, type RoomAccess } from "../auth/access.ts";
import { createFederationMemo, federatedRoomAccess } from "../auth/federation.ts";
import { openSpaceDb, tryOpenGlobalDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import type { UserDid } from "@roomy-space/sdk";
import { decodeTime } from "ulidx";

export interface ReadPosition {
  unreadCount: number;
  /**
   * ISO datetime of the last-read watermark (derived from the `seen_up_to`
   * sort_idx — a ULID whose timestamp is the last-read message's time).
   * Null when there is no real watermark yet (lazily-created rows default
   * `seen_up_to` to '0', and legacy rows carry '0' too).
   */
  lastRead: string | null;
}

/**
 * Decode a read_positions `seen_up_to` value into an ISO timestamp.
 * `seen_up_to` is the last-read message's sort_idx (a ULID); lazily-created
 * rows and legacy rows use the placeholder '0', which is not a valid ULID —
 * that yields null (no real watermark). Returns null on any malformed input.
 */
function decodeSeenUpTo(seenUpTo: string | null | undefined): string | null {
  if (!seenUpTo) return null;
  try {
    return new Date(decodeTime(seenUpTo)).toISOString();
  } catch {
    return null;
  }
}

/**
 * Ensure read_positions rows exist for a user across the given rooms.
 * For rooms where no row exists, creates one with `seen_up_to` set to the
 * current max sort_idx (everything so far is considered "seen") and
 * `unread_count = 0`.
 *
 * This lazy-initialization approach avoids needing to seed rows on join
 * or on createMessage — the first query creates them on demand.
 */
export async function ensureReadPositions(
  db: DbLike,
  userDid: string,
  roomIds: string[],
): Promise<void> {
  if (roomIds.length === 0) return;

  const now = Date.now();
  // Phase 3: `entities` lives in the per-space DBs, not the read-state DB, so
  // `space_did` / a real `seen_up_to` can't be derived from a subquery here.
  // Defaults: space_did '' / seen_up_to '0' (no real watermark — decodes to
  // lastRead null). Materialization populates them correctly via
  // `applyBundle` for live message creates.
  //
  // Batch all rows into a single multi-row INSERT instead of one round-trip
  // per room. The read-state DB lives on its own worker, so the previous
  // per-room loop was an N+1 that saturated it under load (getMetadata /
  // getThreads call this for every channel + engaged thread).
  const values = roomIds.map(() => "(?, ?, '', '0', 0, ?)").join(",");
  const params: (string | number)[] = [];
  for (const roomId of roomIds) {
    params.push(userDid, roomId, now);
  }
  await db.run(
    `insert into read_positions (user_did, room_id, space_did, seen_up_to, unread_count, updated_at)
     values ${values}
     on conflict(user_did, room_id) do nothing`,
    ...params,
  );
}

/**
 * Look up the read position for a single (user, room) pair.
 * Lazily creates the row if it doesn't exist yet.
 */
export async function getReadPosition(
  db: DbLike,
  userDid: string,
  roomId: string,
): Promise<ReadPosition> {
  await ensureReadPositions(db, userDid, [roomId]);

  const row = await db
    .query(
      "select unread_count, seen_up_to from read_positions where user_did = ? and room_id = ?",
    )
    .get<{ unread_count: number; seen_up_to: string }>([userDid, roomId]);

  return {
    unreadCount: row?.unread_count ?? 0,
    lastRead: decodeSeenUpTo(row?.seen_up_to),
  };
}

/**
 * Look up read positions for multiple rooms at once.
 * Returns a Map<roomId, ReadPosition>. Rooms without a row get the default.
 *
 * Calls ensureReadPositions first so that rows are lazily created for any
 * rooms the user hasn't queried before.
 */
export async function getReadPositions(
  db: DbLike,
  userDid: string,
  roomIds: string[],
): Promise<Map<string, ReadPosition>> {
  const result = new Map<string, ReadPosition>();

  if (roomIds.length === 0) return result;

  // Lazily create rows for any rooms that don't have one yet.
  await ensureReadPositions(db, userDid, roomIds);

  // Batch the read into a single `in (...)` query instead of one round-trip
  // per room to the read-state worker — the previous loop was an N+1 that
  // saturated it under load.
  const ph = roomIds.map(() => "?").join(",");
  const rows = await db
    .query(
      `select room_id, unread_count, seen_up_to from read_positions
        where user_did = ? and room_id in (${ph})`,
    )
    .all<{ room_id: string; unread_count: number; seen_up_to: string }>(userDid, ...roomIds);
  for (const r of rows) {
    result.set(r.room_id, {
      unreadCount: r.unread_count,
      lastRead: decodeSeenUpTo(r.seen_up_to),
    });
  }
  // Rooms without a row get the default.
  for (const roomId of roomIds) {
    if (!result.has(roomId)) {
      result.set(roomId, { unreadCount: 0, lastRead: null });
    }
  }

  return result;
}

/**
 * Channels of other (origin) spaces currently federated INTO `spaceId` (an
 * active federation with an origin grant), deduped by room id. The global DB
 * holds the registry; returns an empty array when it isn't available (pure
 * DbLike test fixtures without a worker pool).
 */
export async function getActiveFederatedChannels(
  spaceId: string,
): Promise<Array<{ origin: string; roomId: string }>> {
  const globalDb = tryOpenGlobalDb();
  if (!globalDb) return [];
  const rows = await globalDb
    .query(
      `select frp.space_id as origin, frp.room_id as room_id
         from federation_room_permissions frp
         join space_federations sf
           on sf.space_id = frp.space_id
          and sf.federating_space_did = frp.federating_space_did
        where frp.federating_space_did = ?
          and sf.status = 'active'`,
    )
    .all<{ origin: string; room_id: string }>(spaceId);
  const seen = new Set<string>();
  const out: Array<{ origin: string; roomId: string }> = [];
  for (const r of rows) {
    if (seen.has(r.room_id)) continue;
    seen.add(r.room_id);
    out.push({ origin: r.origin, roomId: r.room_id });
  }
  return out;
}

/**
 * Unread stats for a space: total unread messages plus the number of rooms
 * (channels + engaged threads) that have any unread messages.
 *
 * Used for the per-space unreadCount / unreadRoomCount / unreadThreadCount
 * in getSpaces and space.getMetadata.
 *
 * Filters channels by the user's roomAccess so inaccessible channels
 * (e.g. role-gated or invite-only) are excluded from the totals.
 */
export interface SpaceUnreadStats {
  /** Total unread messages across accessible channels + engaged threads. */
  unreadCount: number;
  /** Number of accessible channels with unread messages. */
  unreadRoomCount: number;
  /** Number of engaged threads with unread messages. */
  unreadThreadCount: number;
}

export async function getSpaceUnreadStats(
  readStateDb: DbLike,
  spaceDb: DbLike,
  userDid: string,
  spaceId: string,
  memo?: AccessMemo,
): Promise<SpaceUnreadStats> {
  const data = await getSpaceSidebarData(readStateDb, spaceDb, userDid, spaceId, memo);
  return {
    unreadCount: data.unreadCount,
    unreadRoomCount: data.unreadRoomCount,
    unreadThreadCount: data.unreadThreadCount,
  };
}

/**
 * Everything `space.getMetadata` needs from the per-space + read-state DBs,
 * computed in ONE pass and returned together so the handler does not re-fetch
 * the same rows (previously getSpaceUnreadStats fetched channel ids, then the
 * handler re-fetched the same channels with names + re-read read positions,
 * duplicating the per-space DB round-trips on the hottest sidebar path).
 *
 * Returns the non-deleted channels (with names + default_access), the batched
 * read-access decisions and read positions for every channel + engaged thread,
 * and the unread aggregates. `getSpaceUnreadStats` is a thin projection of this
 * (it discards the per-room detail) so `getSpaces` stays exactly as cheap as
 * before — `includeReadPositions` lets the sidebar path opt into the per-room
 * read positions without penalising callers that only need the counts.
 */
export interface SpaceSidebarData {
  /** Non-deleted channels in the space (id, name, default_access). */
  channels: Array<{ id: string; name: string | null; defaultAccess: string | null }>;
  /** Read-access decisions for every channel + engaged thread (roomId → decision). */
  access: Map<string, RoomAccess>;
  /** Read positions (unreadCount) for every channel + engaged thread. */
  readPositions: Map<string, ReadPosition>;
  /** Channel ids the caller can read (native channels in this space). */
  accessibleIds: string[];
  /** Federated channel ids (origin's rooms) the caller can read via a grant. */
  federatedIds: string[];
  /** Engaged thread ids belonging to this space. */
  threadIds: string[];
  unreadCount: number;
  unreadRoomCount: number;
  unreadThreadCount: number;
}

export async function getSpaceSidebarData(
  readStateDb: DbLike,
  spaceDb: DbLike,
  userDid: string,
  spaceId: string,
  memo?: AccessMemo,
  options: { includeReadPositions?: boolean } = {},
): Promise<SpaceSidebarData> {
  // Fetch all non-deleted channels in the space (per-space DB), WITH names +
  // default_access. The sidebar assembly in getMetadata reuses these rows
  // directly instead of re-querying channels after the unread computation.
  const allChannelRows = await spaceDb
    .query(
      `select e.id as id, ci.name as name, cr.default_access as default_access
         from entities e
         join comp_room cr on cr.entity = e.id
         left join comp_info ci on ci.entity = e.id
        where e.stream_id = ?
          and cr.label = 'space.roomy.channel'
          and coalesce(cr.deleted, 0) = 0`,
    )
    .all<{ id: string; name: string | null; default_access: string | null }>(spaceId);
  const channels = allChannelRows.map((r) => ({
    id: r.id,
    name: r.name,
    defaultAccess: r.default_access,
  }));

  // Filter to channels the user can read, then ensure read_positions rows exist.
  // All channels share the same parent space, so a single memo collapses the
  // space-level membership/admin/ban checks to one set for the whole request.
  const m = memo ?? createAccessMemo();
  const channelAccess = await roomAccessMany(
    spaceDb,
    channels.map((c) => c.id),
    userDid,
    m,
  );
  const accessible = channels
    .filter((c) => channelAccess.get(c.id)?.canRead)
    .map((c) => c.id);

  await ensureReadPositions(readStateDb, userDid, accessible);

  // Also include threads the user has engaged with (user_thread_activity,
  // read-state DB) that belong to this space (entities, per-space DB).
  // Scoped by space_did so we only scan this space's engaged threads instead
  // of every thread the user has engaged with across all spaces.
  const engagedThreads = await readStateDb
    .query(
      `select uta.thread_id
         from user_thread_activity uta
        where uta.user_did = ?
          and uta.space_did = ?`,
    )
    .all<{ thread_id: string }>([userDid, spaceId]);

  // Batch-check which engaged threads belong to this space in a single query
  // instead of one per-thread round-trip.
  let threadIds: string[] = [];
  if (engagedThreads.length > 0) {
    const eph = engagedThreads.map(() => "?").join(",");
    const belonging = await spaceDb
      .query(
        `select id from entities
          where id in (${eph}) and stream_id = ?`,
      )
      .all<{ id: string }>([...engagedThreads.map((t) => t.thread_id), spaceId]);
    threadIds = belonging.map((r) => r.id);
  }
  // Ensure read_positions rows exist for engaged threads too.
  await ensureReadPositions(readStateDb, userDid, threadIds);

  // Federated channels (channel federation): rooms of OTHER (origin) spaces
  // granted INTO this space. Their read positions live in the shared
  // read-state DB — the origin's materializer bumps unread_count for every
  // user with a row (including this space's members), so the receiving
  // space sees real per-user counts, not a presence flag. Access resolves
  // per-origin via the federation grant (B admin override or receiver
  // grant); native roomAccess would check the ORIGIN space's membership,
  // which B members lack.
  const fedMemo = createFederationMemo();
  const globalDb = tryOpenGlobalDb();
  let federatedIds: string[] = [];
  if (globalDb) {
    const fedChannels = await getActiveFederatedChannels(spaceId);
    if (fedChannels.length > 0) {
      // Group by origin so each origin's per-space DB is opened once.
      const byOrigin = new Map<string, string[]>();
      for (const { origin, roomId } of fedChannels) {
        const list = byOrigin.get(origin) ?? [];
        list.push(roomId);
        byOrigin.set(origin, list);
      }
      for (const [origin, roomIds] of byOrigin) {
        const originDb = openSpaceDb(origin);
        for (const roomId of roomIds) {
          const fed = await federatedRoomAccess(originDb, globalDb, roomId, userDid, {
            spaceDbResolver: openSpaceDb,
            memo: fedMemo,
            accessMemo: m,
          });
          if (fed?.canRead) federatedIds.push(roomId);
        }
      }
      await ensureReadPositions(readStateDb, userDid, federatedIds);
    }
  }

  const allRoomIds = [...accessible, ...threadIds, ...federatedIds];
  let unreadCount = 0;
  let unreadRoomCount = 0;
  let unreadThreadCount = 0;
  if (allRoomIds.length > 0) {
    // Sum unread counts and count rooms with unreads across accessible
    // channels and engaged threads.
    const placeholders = allRoomIds.map(() => "?").join(",");
    const row = await readStateDb
      .query(
        `select coalesce(sum(unread_count), 0) as total,
                coalesce(sum(case when unread_count > 0 then 1 else 0 end), 0) as rooms_with_unread
           from read_positions
          where user_did = ? and room_id in (${placeholders})`,
      )
      .get<{ total: number; rooms_with_unread: number }>([userDid, ...allRoomIds]);
    const total = row?.total ?? 0;
    const roomsWithUnread = row?.rooms_with_unread ?? 0;

    // Split the room count into channels vs engaged threads.
    let threadRoomsWithUnread = 0;
    if (threadIds.length > 0) {
      const tph = threadIds.map(() => "?").join(",");
      const trow = await readStateDb
        .query(
          `select count(*) as n from read_positions
            where user_did = ? and room_id in (${tph}) and unread_count > 0`,
        )
        .get<{ n: number }>([userDid, ...threadIds]);
      threadRoomsWithUnread = trow?.n ?? 0;
    }

    unreadCount = total;
    unreadRoomCount = roomsWithUnread - threadRoomsWithUnread;
    unreadThreadCount = threadRoomsWithUnread;
  }

  // Per-room read positions for the sidebar. Only computed when requested
  // (getSpaces — via getSpaceUnreadStats — needs only the aggregates).
  let readPositions = new Map<string, ReadPosition>();
  if (options.includeReadPositions && allRoomIds.length > 0) {
    readPositions = await getReadPositions(readStateDb, userDid, allRoomIds);
  }

  return {
    channels,
    access: channelAccess,
    readPositions,
    accessibleIds: accessible,
    federatedIds,
    threadIds,
    unreadCount,
    unreadRoomCount,
    unreadThreadCount,
  };
}

/**
 * Count engaged threads with unread messages in a channel. Used for the
 * channel-scoped `unreadThreadCount` in room.getMetadata (the Threads tab
 * badge on a channel page).
 *
 * Only threads the user has engaged with (user_thread_activity) count —
 * matching the sidebar/space-count semantics. Threads the user has never
 * interacted with are surfaced honestly in the threads view itself, but
 * don't contribute to badge counts.
 */
export async function getChannelUnreadThreadCount(
  readStateDb: DbLike,
  spaceDb: DbLike,
  channelId: string,
  userDid: string,
  memo?: AccessMemo,
): Promise<number> {
  // Engaged threads linked from this channel (canonical parent link). The
  // engagement rows live in the read-state DB; the link edges live in the
  // per-space DB.
  const engaged = await readStateDb
    .query(
      `select thread_id from user_thread_activity
        where user_did = ?`,
    )
    .all<{ thread_id: string }>([userDid]);
  if (engaged.length === 0) return 0;

  const eph = engaged.map(() => "?").join(",");
  const linked = await spaceDb
    .query(
      `select link_e.tail as thread_id
         from edges link_e
        where link_e.head = ?
          and link_e.label = 'link'
          and coalesce(json_extract(link_e.payload, '$.canonical_parent'), 0) = 1
          and link_e.tail in (${eph})`,
    )
    .all<{ thread_id: string }>([channelId, ...engaged.map((r) => r.thread_id)]);

  if (linked.length === 0) return 0;

  // Filter to threads the user can read (threads inherit access from their
  // parent channel, but role grants can differ per room). Batch the access
  // checks into one pass instead of one roomAccess round-trip per thread.
  const m = memo ?? createAccessMemo();
  const threadAccess = await roomAccessMany(
    spaceDb,
    linked.map((r) => r.thread_id),
    userDid,
    m,
  );
  const accessible = linked
    .filter((r) => threadAccess.get(r.thread_id)?.canRead)
    .map((r) => r.thread_id);
  if (accessible.length === 0) return 0;

  await ensureReadPositions(readStateDb, userDid, accessible);
  const ph = accessible.map(() => "?").join(",");
  const row = await readStateDb
    .query(
      `select count(*) as n from read_positions
        where user_did = ? and room_id in (${ph}) and unread_count > 0`,
    )
    .get<{ n: number }>([userDid, ...accessible]);
  return row?.n ?? 0;
}
/**
 * Return the set of thread ids the user has engaged with (user_thread_activity
 * rows). Used by the getThreads handlers to compute the honest unread flag:
 * a thread the user has never engaged with has no read_positions row of their
 * own, so it reads as unread even though `unreadCount` is 0.
 */
export async function getEngagedThreadIds(
  db: DbLike,
  userDid: string,
  threadIds: string[],
): Promise<Set<string>> {
  if (threadIds.length === 0) return new Set();
  const ph = threadIds.map(() => "?").join(",");
  const rows = await db
    .query(
      `select thread_id from user_thread_activity
        where user_did = ? and thread_id in (${ph})`,
    )
    .all<{ thread_id: string }>([userDid, ...threadIds]);
  return new Set(rows.map((r) => r.thread_id));
}

/**
 * Return every user with a `read_positions` row for `roomId`. This is
 * exactly the set the materializer's unread-count bump touched (see
 * `applyBundle`), so calling this right after a `createMessage` event
 * yields the affected users in a single query — used to drive targeted
 * `#roomMetadataDiff` frames instead of broadcasting a `getSpaces`
 * invalidation to every connection.
 *
 * The frame carries a `delta` (the unread-count increment, always +1 per
 * message), not the absolute count — the client applies `prev + delta` to
 * each cache entry, avoiding the need to read the absolute count or to
 * know the previous value server-side.
 */
export async function getRoomReadPositionUsers(
  db: DbLike,
  roomId: string,
): Promise<UserDid[]> {
  const rows = await db
    .query(
      `select user_did from read_positions where room_id = ?`,
    )
    .all<{ user_did: string }>([roomId]);
  return rows.map((r) => r.user_did as UserDid);
}

/**
 * Ensure read_positions rows exist for a user across all rooms in a space.
 */
