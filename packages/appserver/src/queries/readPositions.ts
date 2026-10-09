/**
 * Read positions, and the unread counts derived from them.
 *
 * A read position is one durable fact: `seen_up_to`, the `entities.sort_idx` of
 * the last message the user read. It is written only by `updateSeen` (and the
 * boot repair pass), never by materialisation, so it is a value the user owns
 * rather than a counter the write path adjusts.
 *
 * `unreadCount` is not stored. It is the difference between the read position
 * and the room's message set, both of which are already durable, so it is
 * computed where it is read ({@link deriveUnreadCounts}). Storing the
 * difference meant every event that added or removed a message had to remember
 * to adjust it — an increment against state outside the log, which is neither
 * deterministic nor idempotent — and it put a read-modify-write across two
 * databases on the message-creation path.
 *
 * The count is answered by the per-space DB (`entities`), the watermark by the
 * read-state DB, so a reader has to hold both. Every caller here already does:
 * a sidebar or board read opens the space's DB for the rooms' names anyway.
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

/** A room whose unread count is to be derived, with the watermark to count past. */
export interface UnreadQuery {
  roomId: string;
  /**
   * The reader's `seen_up_to`. An empty string or `'0'` is "no real
   * watermark": every message in the room is past it, which is what the range
   * count below yields without special-casing.
   */
  seenUpTo: string;
}

/**
 * Derive the unread count for each `(room, watermark)` pair, in input order.
 *
 * This is the same range count `updateSeen` computes for an explicit watermark
 * (`count(*) … where room = ? and sort_idx > ?`): the messages after the last
 * one the reader saw. Two properties are worth stating, because the increment
 * it replaces had neither:
 *
 *   - It is a pure function of the log-derived tables. Applying the same event
 *     twice cannot change it, because nothing about it is accumulated.
 *   - It reads `entities` by `(room, sort_idx)`, which `idx_entities_room_sort`
 *     covers, so a caught-up room costs an index seek rather than a scan
 *     (measured: 0.03 ms per room against a 200k-message space).
 *
 * A room with no messages, or a watermark at or past its newest, counts zero.
 * Rows are matched on `sort_idx` alone, exactly as `updateSeen` does — an
 * entity the materialiser never keyed (a thread, a room) has a NULL `sort_idx`,
 * which no comparison can pass, so it is not a message and is not counted.
 */
export async function deriveUnreadCounts(
  spaceDb: DbLike,
  queries: readonly UnreadQuery[],
): Promise<number[]> {
  if (queries.length === 0) return [];
  const rows = await spaceDb
    .query(
      `with w(room, wm) as (
         select json_extract(value, '$.roomId'), json_extract(value, '$.seenUpTo')
           from json_each(?1)
       )
       select (select count(*) from entities e
                where e.room = w.room and e.sort_idx > w.wm) as n
         from w`,
    )
    .all<{ n: number }>(JSON.stringify(queries));
  return rows.map((r) => r.n ?? 0);
}

/**
 * Ensure read_positions rows exist for a user across the given rooms, anchored
 * at each room's newest message — everything posted so far is considered seen,
 * so a room the reader has never opened does not open as fully unread.
 *
 * This is the row's creation point (the materialiser no longer creates them):
 * the first sidebar or board read of a room writes it. The anchor comes from
 * the room's own DB, which is why the caller passes it — the read-state DB
 * holds no `entities` to take a `max(sort_idx)` from.
 *
 * The `space_did` is recorded alongside, so a row written here needs no
 * attribution pass to work out which space its room belongs to.
 */
export async function ensureReadPositions(
  db: DbLike,
  spaceDb: DbLike,
  spaceId: string,
  userDid: string,
  roomIds: string[],
): Promise<void> {
  if (roomIds.length === 0) return;

  const anchors = await spaceDb
    .query(
      `select room as room_id, max(sort_idx) as newest
         from entities
        where room in (select value from json_each(?1))
        group by room`,
    )
    .all<{ room_id: string; newest: string | null }>(JSON.stringify(roomIds));
  const newestByRoom = new Map(anchors.map((r) => [r.room_id, r.newest]));

  const now = Date.now();
  // One multi-row INSERT rather than a round-trip per room: the read-state DB
  // lives on its own worker, and getMetadata calls this for every channel plus
  // every engaged thread.
  const params: (string | number)[] = [];
  for (const roomId of roomIds) {
    params.push(userDid, roomId, spaceId, newestByRoom.get(roomId) ?? "0", now);
  }
  await db.run(
    `insert into read_positions (user_did, room_id, space_did, seen_up_to, updated_at)
     values ${roomIds.map(() => "(?, ?, ?, ?, ?)").join(",")}
     on conflict(user_did, room_id) do nothing`,
    ...params,
  );
}

/**
 * Read the stored watermarks for a set of rooms, keyed by room id. Rooms with
 * no row are absent — the caller treats a missing watermark as "no real
 * watermark" (everything unread), which is what a lazily-created row starts
 * as before {@link ensureReadPositions} anchors it.
 */
async function readWatermarks(
  db: DbLike,
  userDid: string,
  roomIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (roomIds.length === 0) return out;
  const ph = roomIds.map(() => "?").join(",");
  const rows = await db
    .query(
      `select room_id, seen_up_to from read_positions
        where user_did = ? and room_id in (${ph})`,
    )
    .all<{ room_id: string; seen_up_to: string }>(userDid, ...roomIds);
  for (const r of rows) out.set(r.room_id, r.seen_up_to);
  return out;
}

/**
 * Look up the read position for a single (user, room) pair — the stored
 * watermark plus the count derived from it against `spaceDb`.
 * Lazily creates the row (anchored at the room's newest message) if it does
 * not exist yet.
 */
export async function getReadPosition(
  db: DbLike,
  spaceDb: DbLike,
  userDid: string,
  roomId: string,
  spaceId?: string,
): Promise<ReadPosition> {
  await ensureReadPositions(db, spaceDb, spaceId ?? "", userDid, [roomId]);
  const positions = await getReadPositions(db, spaceDb, userDid, [roomId]);
  return positions.get(roomId) ?? { unreadCount: 0, lastRead: null };
}

/**
 * Look up read positions for multiple rooms at once.
 * Returns a Map<roomId, ReadPosition>.
 *
 * A room with no `read_positions` row reads as zero unread: the appserver has
 * never been told where the reader is, so there is no watermark to count past.
 * (A room the reader has never opened still reads as unread to the boards, but
 * through their own honest-flag rule rather than a count — see
 * `room.getThreads`.) A row created by {@link ensureReadPositions} is anchored
 * at the room's newest message, so it starts at zero the same way.
 *
 * All the rooms must live in `spaceDb` — the room ids of a channel page, a
 * space board, or one origin space's federated channels. A caller holding
 * rooms from several spaces (the federated sidebar) calls this once per space.
 */
export async function getReadPositions(
  db: DbLike,
  spaceDb: DbLike,
  userDid: string,
  roomIds: readonly string[],
): Promise<Map<string, ReadPosition>> {
  const result = new Map<string, ReadPosition>();
  if (roomIds.length === 0) return result;
  const watermarks = await readWatermarks(db, userDid, roomIds);
  return derivePositions(spaceDb, roomIds, watermarks);
}

/**
 * Derive a position per room from the watermarks that exist, defaulting the
 * rest to zero. Shared by the batched readers so the "no row" rule is stated
 * once.
 */
async function derivePositions(
  spaceDb: DbLike,
  roomIds: readonly string[],
  watermarks: ReadonlyMap<string, string>,
): Promise<Map<string, ReadPosition>> {
  const known = roomIds.filter((roomId) => watermarks.has(roomId));
  const counts = await deriveUnreadCounts(
    spaceDb,
    known.map((roomId) => ({ roomId, seenUpTo: watermarks.get(roomId)! })),
  );
  const countByRoom = new Map(known.map((roomId, i) => [roomId, counts[i] ?? 0]));
  const result = new Map<string, ReadPosition>();
  for (const roomId of roomIds) {
    result.set(roomId, {
      unreadCount: countByRoom.get(roomId) ?? 0,
      lastRead: decodeSeenUpTo(watermarks.get(roomId)),
    });
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
 * The rooms of `spaceId` whose unread state counts for `userDid`: the
 * channels the caller can read, the threads they have engaged with, and the
 * channels federated into this space from an origin they can read. Voice
 * rooms and pages are not unread-bearing and are excluded.
 *
 * The per-room access decisions and the channel/voice rows the sidebar
 * renders are returned alongside, so `getSpaceSidebarData` and
 * `spaceHasUnreads` resolve the candidate set exactly once each.
 */
interface SpaceUnreadCandidates {
  /** Non-deleted channels in the space (id, name, default_access). */
  channels: Array<{ id: string; name: string | null; defaultAccess: string | null }>;
  /** Voice rooms in the space. Kept apart from `channels` because a voice
   *  room has no message timeline: it is not unread-bearing, and the sidebar
   *  renders it with a call control rather than an unread badge. */
  voiceRooms: Array<{ id: string; name: string | null; defaultAccess: string | null }>;
  /** Read-access decisions for every channel + engaged thread (roomId → decision). */
  access: Map<string, RoomAccess>;
  /** Channel ids the caller can read (native channels in this space). */
  accessibleIds: string[];
  /** Engaged thread ids belonging to this space. */
  threadIds: string[];
  /** Federated channel ids (origin's rooms) the caller can read via a grant. */
  federatedIds: string[];
  /**
   * The federated rooms, grouped by the per-space DB that holds their
   * messages. The read-state DB holds their watermarks but no `entities` to
   * count against, so each origin's counts are derived against its own DB.
   */
  federatedByDb: Map<DbLike, string[]>;
}

async function resolveSpaceUnreadCandidates(
  readStateDb: DbLike,
  spaceDb: DbLike,
  userDid: string,
  spaceId: string,
  memo?: AccessMemo,
): Promise<SpaceUnreadCandidates> {
  // Fetch the space's non-deleted rooms, WITH names + default_access. The
  // sidebar assembly in getMetadata reuses these rows directly instead of
  // re-querying after the unread computation.
  // One scan for channels, pages, and voice rooms: pages are dropped below
  // (they are not sidebar entries) but read here so the unread pass skips
  // them, as it always has.
  const allRoomRows = await spaceDb
    .query(
      `select e.id as id, ci.name as name, cr.default_access as default_access,
              cr.label as label
         from entities e
         join comp_room cr on cr.entity = e.id
         left join comp_info ci on ci.entity = e.id
        where e.stream_id = ?
          and cr.label in ('space.roomy.channel', 'space.roomy.voice', 'space.roomy.page')
          and coalesce(cr.deleted, 0) = 0`,
    )
    .all<{
      id: string;
      name: string | null;
      default_access: string | null;
      label: string | null;
    }>(spaceId);
  const channels = allRoomRows
    .filter((r) => r.label === "space.roomy.channel")
    .map((r) => ({
      id: r.id,
      name: r.name,
      defaultAccess: r.default_access,
    }));
  const voiceRooms = allRoomRows
    .filter((r) => r.label === "space.roomy.voice")
    .map((r) => ({
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
    [...channels, ...voiceRooms].map((c) => c.id),
    userDid,
    m,
  );
  const accessible = channels
    .filter((c) => channelAccess.get(c.id)?.canRead)
    .map((c) => c.id);

  await ensureReadPositions(readStateDb, spaceDb, spaceId, userDid, accessible);

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
  await ensureReadPositions(readStateDb, spaceDb, spaceId, userDid, threadIds);

  // Federated channels (channel federation): rooms of OTHER (origin) spaces
  // granted INTO this space. Their read positions live in the shared
  // read-state DB, but their message sets live in the ORIGIN's per-space DB —
  // so both the watermark and the count it is measured against are resolved
  // per origin below.
  const fedMemo = createFederationMemo();
  const globalDb = tryOpenGlobalDb();
  let federatedIds: string[] = [];
  /** Federated rooms grouped by the per-space DB that holds their messages. */
  const federatedByDb = new Map<DbLike, string[]>();
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
        const readable: string[] = [];
        for (const roomId of roomIds) {
          const fed = await federatedRoomAccess(originDb, globalDb, roomId, userDid, {
            spaceDbResolver: openSpaceDb,
            memo: fedMemo,
            accessMemo: m,
          });
          if (fed?.canRead) {
            federatedIds.push(roomId);
            readable.push(roomId);
          }
        }
        if (readable.length > 0) {
          await ensureReadPositions(readStateDb, originDb, origin, userDid, readable);
          federatedByDb.set(originDb, readable);
        }
      }
    }
  }

  return {
    channels,
    voiceRooms,
    access: channelAccess,
    accessibleIds: accessible,
    threadIds,
    federatedIds,
    federatedByDb,
  };
}

/**
 * Derive the read position — and with it the unread count — for every
 * candidate room of a space.
 *
 * One read-state query yields the watermarks; each room's count is then a
 * range count against the DB that holds its messages: the space's own, or an
 * origin's for a federated room. Reading `entities` by `(room, sort_idx)`
 * (`idx_entities_room_sort`) makes a caught-up room an index seek rather than
 * a scan, and because the count is a pure function of the two durable facts,
 * nothing has to keep it in step with the room's message set.
 *
 * `excludeRoomId` drops one room from the candidate set, for a caller asking
 * about the space as it stood *before* that room's event.
 */
async function deriveSpacePositions(
  readStateDb: DbLike,
  spaceDb: DbLike,
  userDid: string,
  candidates: SpaceUnreadCandidates,
  excludeRoomId?: string,
): Promise<Map<string, ReadPosition>> {
  const keep = (id: string): boolean => id !== excludeRoomId;
  const accessibleIds = candidates.accessibleIds.filter(keep);
  const threadIds = candidates.threadIds.filter(keep);
  const allRoomIds = [
    ...accessibleIds,
    ...threadIds,
    ...candidates.federatedIds.filter(keep),
  ];
  if (allRoomIds.length === 0) return new Map();

  const watermarks = await readWatermarks(readStateDb, userDid, allRoomIds);
  const positions = await derivePositions(
    spaceDb,
    [...accessibleIds, ...threadIds],
    watermarks,
  );
  for (const [originDb, roomIds] of candidates.federatedByDb) {
    const kept = roomIds.filter(keep);
    if (kept.length === 0) continue;
    for (const [roomId, pos] of await derivePositions(originDb, kept, watermarks)) {
      positions.set(roomId, pos);
    }
  }
  return positions;
}

/**
 * Whether any of `roomIds` — all of which live in `spaceDb` — has messages
 * past its watermark. The existence form of {@link deriveUnreadCounts}, for a
 * caller that only needs to know if the answer is non-zero.
 *
 * Asking the count question and scanning the result would derive a count for
 * every candidate room to look for one `> 0`, allocating a `ReadPosition`, a
 * `Map` entry and a result row per room. `spaceHasUnreads` is the per-message
 * path — a message create asks it once per reader the message made newly
 * unread — and the candidate set is a space's whole sidebar, so the probe
 * stops at the first room that answers instead.
 *
 * A room with no stored watermark is not a candidate: the caller's
 * `ensureReadPositions` gives every candidate room a row, and one that is
 * missing anyway has no position to count past, which its siblings read as
 * zero unread.
 */
async function anyUnread(
  spaceDb: DbLike,
  roomIds: readonly string[],
  watermarks: ReadonlyMap<string, string>,
): Promise<boolean> {
  const queries: UnreadQuery[] = [];
  for (const roomId of roomIds) {
    const seenUpTo = watermarks.get(roomId);
    if (seenUpTo !== undefined) queries.push({ roomId, seenUpTo });
  }
  if (queries.length === 0) return false;

  const row = await spaceDb
    .query(
      `with w(room, wm) as (
         select json_extract(value, '$.roomId'), json_extract(value, '$.seenUpTo')
           from json_each(?1)
       )
       select 1 as one
         from w
        where exists (select 1 from entities e
                       where e.room = w.room and e.sort_idx > w.wm)
        limit 1`,
    )
    .get<{ one: number }>(JSON.stringify(queries));
  return row !== null && row !== undefined;
}

/**
 * Whether any room of `spaceId` has unread messages for `userDid`.
 *
 * The space list carries this level, not counts (see `space.getSpaces`), so
 * this is one existence probe over the same candidate rooms
 * `space.getMetadata` counts, with the same access filtering — no
 * aggregation, and the probe stops at the first unread room.
 *
 * `excludeRoomId` drops one room from the candidate set. The message-create
 * path uses it to ask "was the space already unread by some OTHER room?" — the
 * room the message just landed in is unread by construction and must not
 * answer that question.
 */
export async function spaceHasUnreads(
  readStateDb: DbLike,
  spaceDb: DbLike,
  userDid: string,
  spaceId: string,
  memo?: AccessMemo,
  excludeRoomId?: string,
): Promise<boolean> {
  const candidates = await resolveSpaceUnreadCandidates(
    readStateDb,
    spaceDb,
    userDid,
    spaceId,
    memo,
  );
  const keep = (id: string): boolean => id !== excludeRoomId;
  // The space's own rooms are asked as one group, and each federated origin's
  // as another: they live in different DBs, so the probe can only short-circuit
  // within a group — a hit in any group is the answer either way.
  const ownRooms = [
    ...candidates.accessibleIds.filter(keep),
    ...candidates.threadIds.filter(keep),
  ];
  const watermarks = await readWatermarks(readStateDb, userDid, [
    ...ownRooms,
    ...candidates.federatedIds.filter(keep),
  ]);
  if (await anyUnread(spaceDb, ownRooms, watermarks)) return true;
  for (const [originDb, roomIds] of candidates.federatedByDb) {
    if (await anyUnread(originDb, roomIds.filter(keep), watermarks)) return true;
  }
  return false;
}

/**
 * Everything `space.getMetadata` needs from the per-space + read-state DBs,
 * computed in ONE pass and returned together so the handler does not re-fetch
 * the same rows — the per-space DB round-trips on this sidebar path are the
 * hottest in the app.
 *
 * Returns the candidate rooms (channels, voice rooms, access decisions), the
 * per-room read positions, and the unread aggregates. `includeReadPositions`
 * lets a caller that only needs the aggregates skip handing back the map.
 */
export interface SpaceSidebarData extends SpaceUnreadCandidates {
  /** Read positions (unreadCount) for every channel + engaged thread. */
  readPositions: Map<string, ReadPosition>;
  /** Total unread messages across accessible channels + engaged threads. */
  unreadCount: number;
  /** Accessible channels with unread messages. */
  unreadRoomCount: number;
  /** Engaged threads with unread messages. */
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
  const candidates = await resolveSpaceUnreadCandidates(
    readStateDb,
    spaceDb,
    userDid,
    spaceId,
    memo,
  );
  const positions = await deriveSpacePositions(readStateDb, spaceDb, userDid, candidates);
  const unreadOf = (roomId: string): number => positions.get(roomId)?.unreadCount ?? 0;

  const allRoomIds = [
    ...candidates.accessibleIds,
    ...candidates.threadIds,
    ...candidates.federatedIds,
  ];
  const unreadCount = allRoomIds.reduce((sum, id) => sum + unreadOf(id), 0);
  const roomsWithUnread = allRoomIds.filter((id) => unreadOf(id) > 0).length;
  const threadRoomsWithUnread = candidates.threadIds.filter((id) => unreadOf(id) > 0).length;

  // Per-room read positions for the sidebar. Only returned when requested —
  // a caller that needs only the aggregates does not pay to hand back a map.
  const readPositions = options.includeReadPositions
    ? positions
    : new Map<string, ReadPosition>();

  return {
    ...candidates,
    readPositions,
    unreadCount,
    unreadRoomCount: roomsWithUnread - threadRoomsWithUnread,
    unreadThreadCount: threadRoomsWithUnread,
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

  // A thread the user engaged with but never opened has no row until this
  // call creates it, anchored at the thread's newest message — so it counts
  // only what arrives afterwards, which is the same rule the sidebar uses.
  await ensureReadPositions(readStateDb, spaceDb, "", userDid, accessible);
  const watermarks = await readWatermarks(readStateDb, userDid, accessible);
  const counts = await deriveUnreadCounts(
    spaceDb,
    accessible.map((roomId) => ({ roomId, seenUpTo: watermarks.get(roomId) ?? "0" })),
  );
  return counts.filter((n) => n > 0).length;
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
 * Every user tracking `roomId` — the users with a `read_positions` row for it,
 * with the watermark they hold. A row exists for a user once they have opened
 * the room (or had the sidebar create one for them), so this is exactly the
 * audience a new message can make newly-unread.
 *
 * Used to drive targeted `#roomMetadataDiff` frames instead of broadcasting a
 * `getSpaces` invalidation to every connection. The frame carries the unread
 * increment for the users whose count this message moved, which the caller
 * derives from these watermarks against the room's messages.
 */
export async function getRoomReadPositionWatermarks(
  db: DbLike,
  roomId: string,
): Promise<Array<{ userDid: UserDid; seenUpTo: string }>> {
  const rows = await db
    .query(
      `select user_did, seen_up_to from read_positions where room_id = ?`,
    )
    .all<{ user_did: string; seen_up_to: string }>([roomId]);
  return rows.map((r) => ({
    userDid: r.user_did as UserDid,
    seenUpTo: r.seen_up_to,
  }));
}
