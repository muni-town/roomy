/**
 * Thread activity helper.
 *
 * Used by `space.getThreads`, `room.getThreads`, and the `recentThreads` field
 * of `room.getMetadata`. Returns each thread with its latest message timestamp
 * and up to 3 unique recent participants.
 *
 * Forwarded messages are forward-reference entities with no own content/author
 * — their timestamp and author live on the original message reached via the
 * `forward` edge. We follow that edge (coalescing the message's own content
 * with the forwarded original's) so a thread created by forwarding messages
 * still reports a latest timestamp, recent participants (the original authors),
 * and a latest message — matching what `selectMessages` displays.
 *
 * Implementation note: the participant list is a per-thread `json_group_array`
 * aggregate over the top-N most recent messages, not a window function keyed
 * on a SELECT alias — window functions evaluate before aliases, so that shape
 * silently returns 0–1 members. The aggregate sidesteps that.
 */

import type { DbLike } from "../db/types.ts";
import { decodeContent, decodeRichTextBody } from "../db/content.ts";
import { RICHTEXT_MIME, blocksToPlaintext } from "@roomy-space/sdk";
import { hydrateProfiles } from "./profileStore.ts";
import {
  readRoomActivityProjection,
  rebuildRoomActivity,
  warnProjectionUnavailable,
  type RoomActivityAuthor,
} from "./roomActivityProjection.ts";

export interface ThreadMember {
  did: string;
  name: string | null;
  avatar: string | null;
}

export interface ThreadMessage {
  id: string;
  content: string;
  author: ThreadMember;
  timestamp: string | null;
}

export interface ThreadActivity {
  id: string;
  /** `thread` (canonically linked from a channel) or `channel`. */
  kind: "thread" | "channel";
  name: string | null;
  /** Canonical parent channel ID (head of the canonical 'link' edge), null if none. */
  canonicalParent: string | null;
  /** Latest message timestamp in this room (ISO string), null if no messages. */
  latestTimestamp: string | null;
  latestMembers: ThreadMember[];
  /** The most recent message in this room, null if no messages. */
  latestMessage: ThreadMessage | null;
}

export type ThreadScope =
  | { kind: "space"; spaceId: string }
  | { kind: "channel"; channelId: string };

export interface ListActivityOptions {
  /** Room kinds to include (defaults to `["thread"]`). */
  kinds?: Array<"thread" | "channel">;
}

/**
 * Rooms visible in this scope with activity metadata.
 *
 * Space scope can include channels via `opts.kinds` (the space index board);
 * channel scope is always threads. Each row carries its `kind`.
 *
 * Supports cursor-based pagination via the `activity_item` table's
 * `last_activity_at` column. Cursor format: `"<last_activity_at>::<room_id>"`.
 * Returns at most `limit` rooms (default 50), plus a `cursor` for the next
 * page (null when there are no more results).
 *
 * Rooms with no messages (no `activity_item` row) get sort key 0, so they
 * sort last (after all active rooms) and don't block pagination past active
 * rooms.
 *
 * The caller is responsible for filtering by read access — this helper does
 * not check permissions.
 */
export async function listThreadActivity(
  db: DbLike,
  scope: ThreadScope,
  limit = 50,
  cursor?: string | null,
  search?: string | null,
  opts: ListActivityOptions = {},
): Promise<{ threads: ThreadActivity[]; cursor: string | null }> {
  // Step 1: select the candidate rooms in scope, with cursor pagination.
  // LEFT JOIN activity_item so we can order/filter by last_activity_at even
  // for rooms with no messages (they get NULL -> COALESCE to 0).
  let cursorTs: number | null = null;
  let cursorId: string | null = null;
  if (cursor) {
    const sepIdx = cursor.lastIndexOf("::");
    if (sepIdx !== -1) {
      cursorTs = Number(cursor.slice(0, sepIdx));
      cursorId = cursor.slice(sepIdx + 2);
    }
  }

  const kinds = opts.kinds ?? ["thread"];
  if (kinds.length === 0) return { threads: [], cursor: null };

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (scope.kind === "space") {
    conditions.push("e.stream_id = ?");
    params.push(scope.spaceId);
  } else {
    conditions.push("link_e.head = ?");
    params.push(scope.channelId);
  }
  conditions.push(`cr.label in (${kinds.map(() => "?").join(",")})`);
  params.push(
    ...kinds.map((k) => (k === "thread" ? "space.roomy.thread" : "space.roomy.channel")),
  );
  conditions.push("coalesce(cr.deleted, 0) = 0");

  // Optional case-insensitive substring filter on room name. Applied in
  // SQL (not JS) so cursor pagination stays correct — filtering after the
  // page fetch would skip matches and misalign the cursor.
  if (search && search.trim() !== "") {
    conditions.push("ci.name like ?");
    params.push(`%${search.trim()}%`);
  }

  // Cursor: newest-first by last_activity_at, tiebreak by room_id.
  if (cursorTs !== null && cursorId !== null) {
    conditions.push(
      "(coalesce(ai.last_activity_at, 0) < ? or (coalesce(ai.last_activity_at, 0) = ? and e.id > ?))",
    );
    params.push(cursorTs, cursorTs, cursorId);
  }

  const whereClause = conditions.join(" and ");

  const joinClause = scope.kind === "space"
    ? ""
    : "join edges link_e on link_e.tail = e.id and link_e.label = 'link' and coalesce(json_extract(link_e.payload, '$.canonical_parent'), 0) = 1";

  const threads = await db
    .query(
      `select e.id as id, ci.name as name, cr.label as label,
              coalesce(ai.last_activity_at, 0) as sort_key
         from entities e
         join comp_room cr on cr.entity = e.id
         left join comp_info ci on ci.entity = e.id
         left join activity_item ai on ai.room_id = e.id
         ${joinClause}
        where ${whereClause}
        order by sort_key desc, e.id asc
        limit ?`,
    )
    .all<{ id: string; name: string | null; label: string | null; sort_key: number }>([...params, limit + 1]);

  if (threads.length === 0) return { threads: [], cursor: null };

  // Check if there are more pages (we fetched one extra row).
  const hasMore = threads.length > limit;
  const pageThreads = hasMore ? threads.slice(0, limit) : threads;

  const threadIds = pageThreads.map((t) => t.id);
  const activityByRoom = await fetchRoomActivity(db, threadIds);

  const results: ThreadActivity[] = pageThreads.map((t) => {
    const act = activityByRoom.get(t.id);
    return {
      id: t.id,
      kind: t.label === "space.roomy.channel" ? "channel" : "thread",
      name: t.name,
      canonicalParent: act?.canonicalParent ?? null,
      latestTimestamp: act?.latestTimestamp ?? null,
      latestMembers: act?.latestMembers ?? [],
      latestMessage: act?.latestMessage ?? null,
    };
  });

  // Compute next cursor from the last visible thread.
  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageThreads[pageThreads.length - 1]!;
    nextCursor = `${last.sort_key}::${last.id}`;
  }

  return { threads: results, cursor: nextCursor };
}

/**
 * Batch-fetch activity metadata for a set of rooms: latest message timestamp,
 * up to 3 unique recent participants, canonical parent channel, and the latest
 * message (content decoded to plaintext). Shared by `listThreadActivity` and
 * `space.roomy.search.rooms` so search results render with the same activity
 * columns as the board views.
 *
 * Served from the `room_activity` projection, which holds the same
 * facts reduced once per write. `scanRoomActivity` below is the fallback: the
 * projection is an optimisation, and a page it cannot answer in full is read
 * from the messages themselves.
 *
 * Rooms with no messages are absent from the map (or carry empty arrays) —
 * callers treat that as "no activity".
 */
export async function fetchRoomActivity(
  db: DbLike,
  roomIds: string[],
): Promise<Map<string, ThreadActivity>> {
  if (roomIds.length === 0) return new Map();

  const projected = await fetchProjectedRoomActivity(db, roomIds);
  const out = projected ?? (await scanRoomActivity(db, roomIds));

  // Warm on miss — the `room_access` pattern (queries/roomAccessProjection.ts).
  // The scan below has just derived every room's answer from the live tables, so
  // writing those rows now means this page is projected from the next read on.
  //
  // Without this, the projection could never cover a room with no messages: no
  // message event exists to maintain its row, and because a page is projected
  // only when EVERY room in it is, a single quiet room would send the whole board
  // back to the scan permanently. It is also what heals a blue-green rebuild,
  // where rematerialisation deliberately invalidates without populating.
  //
  // Best-effort: the caller already holds a correct answer, so a failed warm must
  // never turn a successful read into an error.
  if (!projected) {
    try {
      await rebuildRoomActivity(db, roomIds);
    } catch (err) {
      warnProjectionUnavailable(err);
    }
  }

  // Resolve participant + latest-message author profiles from the global store
  // (with an in-memory cache). A user's profile entity lives in their own
  // stream, not this space's stream, so the per-space comp_info join is null
  // for cross-stream users. The global `profiles` table is authoritative; the
  // per-space value (if any) acts as a fallback. Shared by both paths so a
  // projected row and a scanned row hydrate identically.
  const membersToHydrate: ThreadMember[] = [];
  for (const t of out.values()) {
    membersToHydrate.push(...t.latestMembers);
    if (t.latestMessage?.author) membersToHydrate.push(t.latestMessage.author);
  }
  await hydrateProfiles(
    membersToHydrate,
    (m) => m.did,
    (m, p) => {
      if (p.name != null) m.name = p.name;
      if (p.avatar != null) m.avatar = p.avatar;
    },
  );

  return out;
}

/**
 * The scan fallback: derive each room's activity from its
 * messages. Used for a page the projection cannot answer — a
 * room whose row was invalidated, or a handle whose schema predates the table.
 *
 * Its cost is O(messages in scope) — SQLite has no `LIMIT` per group, so the
 * latest message is picked by reading every message in every requested room and
 * reducing in JS (measured: 8001 rows to keep 2 at 8000 messages). The
 * projection exists to avoid exactly that.
 */
async function scanRoomActivity(
  db: DbLike,
  roomIds: string[],
): Promise<Map<string, ThreadActivity>> {
  const out = new Map<string, ThreadActivity>();
  if (roomIds.length === 0) return out;

  // An in-process handle has no thread boundary to cross, so the whole
  // reduction runs in ONE statement and the JS fold disappears. The IPC path
  // below returns the same answer, statement for statement and row for row —
  // `queries/threadActivity.test.ts` asserts the two agree — because the
  // alternative (this reducer over `AsyncDatabase`) is the expensive one, not
  // the correct one.
  if (db.backend === "sqlite") return scanRoomActivityInProcess(db, roomIds);

  const ph = roomIds.map(() => "?").join(",");

  // Latest timestamps for all rooms at once.
  const latestRows = await db
    .query(
      `select e.room as room,
              max(coalesce(cc.timestamp, fwd_cc.timestamp)) as ts
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges forward_e
           on forward_e.head = e.id and forward_e.label = 'forward'
         left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
        where e.room in (${ph})
          and (cc.entity is not null or forward_e.tail is not null)
        group by e.room`,
    )
    .all<{ room: string; ts: number | null }>([...roomIds]);
  const latestMap = new Map(latestRows.map((r) => [r.room, r.ts]));

  // Recent participants (up to 3 per room). For forwarded messages the
  // author edge lives on the original (reached via the `forward` edge), so
  // we coalesce the message's own author with the forwarded original's.
  const participantRows = await db
    .query(
      `select msg.room as room,
              coalesce(author_e.tail, fwd_author_e.tail) as did,
              ci.name as name,
              ci.avatar as avatar,
              max(coalesce(cc.timestamp, fwd_cc.timestamp)) as ts
         from entities msg
         left join comp_content cc on cc.entity = msg.id
         left join edges author_e
           on author_e.head = msg.id and author_e.label = 'author'
         left join edges forward_e
           on forward_e.head = msg.id and forward_e.label = 'forward'
         left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
         left join edges fwd_author_e
           on fwd_author_e.head = forward_e.tail and fwd_author_e.label = 'author'
         left join comp_info ci
           on ci.entity = coalesce(author_e.tail, fwd_author_e.tail)
        where msg.room in (${ph})
          and (cc.entity is not null or forward_e.tail is not null)
          and coalesce(author_e.tail, fwd_author_e.tail) is not null
        group by msg.room, coalesce(author_e.tail, fwd_author_e.tail)
        order by msg.room, ts desc, coalesce(author_e.tail, fwd_author_e.tail) asc`,
    )
    .all<{ room: string; did: string; name: string | null; avatar: string | null; ts: number | null }>([...roomIds]);

  const participantsMap = new Map<string, ThreadMember[]>();
  for (const r of participantRows) {
    let arr = participantsMap.get(r.room);
    if (!arr) {
      arr = [];
      participantsMap.set(r.room, arr);
    }
    if (arr.length < 3) {
      arr.push({ did: r.did, name: r.name, avatar: r.avatar });
    }
  }

  // Canonical parent per room.
  const parentRows = await db
    .query(
      `select tail, head from edges
        where tail in (${ph})
          and label = 'link'
          and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1`,
    )
    .all<{ tail: string; head: string }>([...roomIds]);
  const parentMap = new Map(parentRows.map((r) => [r.tail, r.head]));

  // Room kind and name. `fetchRoomActivity` is used by the search handler, which
  // matches channels and threads alike, so the kind must come from the room's
  // own label rather than being assumed to be a thread.
  const roomRows = await db
    .query(
      `select cr.entity as room_id, cr.label as label, ci.name as name
         from comp_room cr
         left join comp_info ci on ci.entity = cr.entity
        where cr.entity in (${ph})`,
    )
    .all<{ room_id: string; label: string | null; name: string | null }>([...roomIds]);
  const roomKinds = new Map(roomRows.map((r) => [r.room_id, r.label]));
  const roomNames = new Map<string, string>();
  for (const r of roomRows) if (r.name != null) roomNames.set(r.room_id, r.name);
  // Latest message per room. SQLite doesn't support LIMIT per group, so we
  // read every message-shaped row in scope and pick the newest per room in JS
  // — but only the ORDERING columns of it.
  //
  // The message BODY is deliberately not selected here. This statement returns
  // one row per message in the requested rooms to keep one per room (measured on
  // the 124k-message probe space: 1724 rows to keep 50), and every one of those
  // rows is structured-cloned across the worker boundary on its way back. The
  // body is the largest column in it — 196 kB across those 1724 rows — and all
  // but 50 rows' worth is discarded unread by the fold below. Picking the winner
  // first and fetching its body afterwards moves that payload off the boundary
  // without changing the answer: the `id`s are identical, so the rows read back
  // are the rows the fold chose.
  const winnerRows = await db
    .query(
      `select e.room as room,
              e.id as id,
              coalesce(cc.timestamp, fwd_cc.timestamp) as timestamp
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges forward_e
           on forward_e.head = e.id and forward_e.label = 'forward'
         left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
        where e.room in (${ph})
          and (cc.entity is not null or forward_e.tail is not null)
          and coalesce(cc.timestamp, fwd_cc.timestamp) is not null`,
    )
    .all<{ room: string; id: string; timestamp: number | null }>([...roomIds]);

  const winnerIds = new Map<string, { id: string; timestamp: number }>();
  for (const r of winnerRows) {
    const existing = winnerIds.get(r.room);
    // Newest timestamp wins; a tie breaks by message id. The tie-break is
    // shared with the `room_activity` projection, which cannot otherwise agree
    // with this fold: two messages can share a millisecond (a pair created
    // together, or bridged messages carrying sender-supplied times), and
    // without a stated rule each path would pick whichever row it happened to
    // see first.
    const ts = r.timestamp ?? 0;
    if (!existing || ts > existing.timestamp || (ts === existing.timestamp && r.id > existing.id)) {
      winnerIds.set(r.room, { id: r.id, timestamp: ts });
    }
  }

  const latestMsgMap = await fetchLatestMessageContent(db, winnerIds);

  for (const roomId of roomIds) {
    const latest = latestMap.get(roomId);
    const members = participantsMap.get(roomId) ?? [];
    const parent = parentMap.get(roomId);
    const latestMsgRow = latestMsgMap.get(roomId);

    let latestMessage: ThreadMessage | null = null;
    if (latestMsgRow && latestMsgRow.author_did) {
      latestMessage = {
        id: latestMsgRow.id,
        content: decodeBoardPreview(latestMsgRow.mime_type, latestMsgRow.data),
        author: {
          did: latestMsgRow.author_did,
          name: latestMsgRow.author_name,
          avatar: latestMsgRow.author_avatar,
        },
        timestamp: latestMsgRow.timestamp
          ? new Date(latestMsgRow.timestamp).toISOString()
          : null,
      };
    }

    out.set(roomId, {
      id: roomId,
      kind: roomKinds.get(roomId) === "space.roomy.channel" ? "channel" : "thread",
      name: roomNames.get(roomId) ?? null,
      canonicalParent: parent ?? null,
      latestTimestamp: latest ? new Date(latest).toISOString() : null,
      latestMembers: members,
      latestMessage,
    });
  }

  return out;
}

/** The latest message a room previews, as the scan's fold produces it. */
interface LatestMessageRow {
  id: string;
  mime_type: string | null;
  data: Buffer | Uint8Array | null;
  author_did: string | null;
  author_name: string | null;
  author_avatar: string | null;
  timestamp: number;
}

/**
 * Read the board columns — decoded body, author, canonical time — for the
 * message ids the fold above picked, one per room.
 *
 * Two statements rather than one: the second only has to find the 50 rows the
 * page keeps instead of every row it considered, which is the whole point of
 * splitting the fold (see the caller). The author's name/avatar come from the
 * per-space `comp_info`; a cross-stream author has no row here and is hydrated
 * from the global store by `fetchRoomActivity` afterwards, as on every path.
 */
async function fetchLatestMessageContent(
  db: DbLike,
  winnerIds: Map<string, { id: string; timestamp: number }>,
): Promise<Map<string, LatestMessageRow>> {
  const out = new Map<string, LatestMessageRow>();
  if (winnerIds.size === 0) return out;

  const idToRoom = new Map<string, string>();
  for (const [room, w] of winnerIds) idToRoom.set(w.id, room);

  const rows = await db
    .query(
      `select e.id as id,
              coalesce(cc.mime_type, fwd_cc.mime_type) as mime_type,
              coalesce(cc.data, fwd_cc.data) as data,
              coalesce(author_e.tail, fwd_author_e.tail) as author_did,
              author_info.name as author_name,
              author_info.avatar as author_avatar
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges author_e
           on author_e.head = e.id and author_e.label = 'author'
         left join edges forward_e
           on forward_e.head = e.id and forward_e.label = 'forward'
         left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
         left join edges fwd_author_e
           on fwd_author_e.head = forward_e.tail and fwd_author_e.label = 'author'
         left join comp_info author_info
           on author_info.entity = coalesce(author_e.tail, fwd_author_e.tail)
        where e.id in (select value from json_each(?1))`,
    )
    .all<{
      id: string;
      mime_type: string | null;
      data: Buffer | Uint8Array | null;
      author_did: string | null;
      author_name: string | null;
      author_avatar: string | null;
    }>(JSON.stringify([...idToRoom.keys()]));

  for (const r of rows) {
    const room = idToRoom.get(r.id);
    if (room === undefined) continue;
    out.set(room, {
      id: r.id,
      mime_type: r.mime_type,
      data: r.data,
      author_did: r.author_did,
      author_name: r.author_name,
      author_avatar: r.author_avatar,
      timestamp: winnerIds.get(room)!.timestamp,
    });
  }
  return out;
}

/**
 * `scanRoomActivity` for an in-process handle: the same reduction, one
 * statement, no JS fold.
 *
 * The statements the IPC path issues each repeat the same
 * `entities → comp_content → forward → author` join over the same room set,
 * and the latest-message one additionally returns every message's
 * `comp_content.data`. On the worker path that duplication is what the
 * projection removes (measured at 8000 messages: 8001 rows to keep 2). Here
 * the join runs once, is reduced by SQLite, and the body bytes reach JS only
 * for the row that is actually previewed — the 50-52 rows a board page keeps,
 * not the ~1700 it considered.
 *
 * The answer is identical to the IPC path's, clause for clause:
 *
 *  - the room shape comes from `comp_room`/`comp_info`, with `comp_room` the
 *    driving table so a requested id with no room row is absent from both;
 *  - a row is message-shaped when it has its own content OR a `forward` edge,
 *    and the canonical time coalesces the forwarded original's;
 *  - the latest message is the window's `rn = 1` and a room with no timestamped
 *    message yields NULL, which reads as "no activity" below;
 *  - authors are grouped per `(room, author)` with `max(ts)`, ordered
 *    `ts desc, did asc` and capped at 3, with a null-`ts` author (a system
 *    message — the "x joined the space" row) ordered last;
 *  - ties in the latest message break by message id, and a tie between two
 *    authors' newest messages breaks by DID — both stated rules in
 *    `roomActivityProjection.ts`, shared here so the projection, this scan and
 *    the IPC scan cannot disagree about a millisecond.
 */
async function scanRoomActivityInProcess(
  db: DbLike,
  roomIds: string[],
): Promise<Map<string, ThreadActivity>> {
  const rows = await db
    .query(
      `with rooms as (select distinct cr.entity as id, p.head as parent, cr.label as label, ci.name as name
                        from comp_room cr
                        left join comp_info ci on ci.entity = cr.entity
                        left join edges p
                               on p.tail = cr.entity and p.label = 'link'
                              and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
                       where cr.entity in (select value from json_each(?1))),
            entries as (
              select e.id as id, e.room as room,
                     coalesce(a.tail, fa.tail) as did,
                     coalesce(cc.timestamp, fcc.timestamp) as ts,
                     coalesce(cc.mime_type, fcc.mime_type) as mime_type,
                     coalesce(cc.data, fcc.data) as data
                from entities e
                left join comp_content cc on cc.entity = e.id
                left join edges a  on a.head  = e.id and a.label  = 'author'
                left join edges f  on f.head  = e.id and f.label  = 'forward'
                left join comp_content fcc on fcc.entity = f.tail
                left join edges fa on fa.head = f.tail and fa.label = 'author'
               where e.room in (select id from rooms)
                 and (cc.entity is not null or f.tail is not null)),
            latest as (
              select room, id, ts, mime_type, data from (
                select room, id, ts, mime_type, data,
                       row_number() over (partition by room order by ts desc, id desc) as rn
                  from entries
                 where ts is not null
              ) where rn = 1),
            recent as (
              select room, did, ts, row_number() over (
                       partition by room order by ts desc, did asc) as rn
                from (select room, did, max(ts) as ts
                        from entries
                       where did is not null
                       group by room, did))
       select r.id as room_id,
              r.parent as parent_id,
              r.label as label,
              r.name as name,
              l.id as latest_message_id,
              l.ts as latest_ts,
              l.mime_type as latest_mime_type,
              l.data as latest_data,
              coalesce(la.tail, lfa.tail) as latest_author_did,
              (select json_group_array(json_object('did', did, 'ts', ts) order by ts desc, did asc)
                 from (select did, ts from recent
                        where room = r.id and rn <= 3)) as latest_members
         from rooms r
         left join latest l on l.room = r.id
         left join edges la on la.head = l.id and la.label = 'author'
         left join edges lf on lf.head = l.id and lf.label = 'forward'
         left join edges lfa on lfa.head = lf.tail and lfa.label = 'author'`,
    )
    .all<{
      room_id: string;
      parent_id: string | null;
      label: string | null;
      name: string | null;
      latest_message_id: string | null;
      latest_ts: number | null;
      latest_mime_type: string | null;
      latest_data: Buffer | Uint8Array | null;
      latest_author_did: string | null;
      latest_members: string | null;
    }>(JSON.stringify(roomIds));

  // Hydrate the authors the board can render — the capped member list plus the
  // latest message's author — in one batched read, exactly as the IPC path's
  // `fetchRoomActivity` does for the page. `hydrateProfiles` in the caller then
  // layers the global store over these names, as it does there.
  const memberDids = new Set<string>();
  for (const r of rows) {
    for (const a of parseAuthors(r.latest_members)) memberDids.add(a.did);
    if (r.latest_author_did != null) memberDids.add(r.latest_author_did);
  }
  const profiles = new Map<string, { name: string | null; avatar: string | null }>();
  if (memberDids.size > 0) {
    const dids = [...memberDids];
    const infoRows = await db
      .query(
        `select ci.entity as did, ci.name as name, ci.avatar as avatar
           from comp_info ci
          where ci.entity in (select value from json_each(?1))`,
      )
      .all<{ did: string; name: string | null; avatar: string | null }>(JSON.stringify(dids));
    for (const r of infoRows) profiles.set(r.did, { name: r.name, avatar: r.avatar });
  }

  const out = new Map<string, ThreadActivity>();
  for (const r of rows) {
    const latestMembers: ThreadMember[] = parseAuthors(r.latest_members).map((a) => {
      const p = profiles.get(a.did);
      return { did: a.did, name: p?.name ?? null, avatar: p?.avatar ?? null };
    });

    // A latest message the board can render needs an id AND an author — the
    // same condition the IPC path applies. The timestamp is the message's own
    // (`latest_ts`, the room's MAX), not the author's, so a room whose newest
    // message was superseded by nothing still previews at the time it was sent.
    let latestMessage: ThreadMessage | null = null;
    if (r.latest_message_id != null && r.latest_author_did != null) {
      const p = profiles.get(r.latest_author_did);
      latestMessage = {
        id: r.latest_message_id,
        content: decodeBoardPreview(r.latest_mime_type, r.latest_data),
        author: {
          did: r.latest_author_did,
          name: p?.name ?? null,
          avatar: p?.avatar ?? null,
        },
        timestamp: r.latest_ts != null ? new Date(r.latest_ts).toISOString() : null,
      };
    }

    out.set(r.room_id, {
      id: r.room_id,
      kind: r.label === "space.roomy.channel" ? "channel" : "thread",
      name: r.name,
      canonicalParent: r.parent_id,
      latestTimestamp: r.latest_ts != null ? new Date(r.latest_ts).toISOString() : null,
      latestMembers,
      latestMessage,
    });
  }

  // A requested id with no `comp_room` row is not a room. The IPC scan emits a
  // blank entry for it (its JS loop over `roomIds` is unconditional), so this
  // one does too: the two implementations are interchangeable, and a caller
  // that passes an id it did not read out of `comp_room` gets the same answer
  // either way. Nothing in the appserver passes one — `listThreadActivity`
  // selects the page from `comp_room` — so this only pins the two paths
  // together.
  for (const roomId of roomIds) {
    if (out.has(roomId)) continue;
    out.set(roomId, {
      id: roomId,
      kind: "thread",
      name: null,
      canonicalParent: null,
      latestTimestamp: null,
      latestMembers: [],
      latestMessage: null,
    });
  }

  return out;
}

/** Parse the JSON array of `{did, ts}` the reduced scan emits. */
function parseAuthors(raw: string | null): RoomActivityAuthor[] {
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RoomActivityAuthor[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const did = (entry as Record<string, unknown>).did;
    const ts = (entry as Record<string, unknown>).ts;
    if (typeof did !== "string") continue;
    if (ts !== null && typeof ts !== "number") continue;
    out.push({ did, ts });
  }
  return out;
}

/**
 * Decode a message body to the plaintext a board row previews.
 *
 * Rich-text bodies are base64-encoded on the wire (`decodeContent` base64s
 * non-text mimeTypes), so they decode to blocks and then to plaintext — a board
 * must show readable text, not the encoded blob. Legacy `text/*` content is
 * already plaintext and passes through. Shared by the projection read and the
 * live scan so both render the same preview from the same row.
 */
function decodeBoardPreview(
  mime: string | null,
  data: Buffer | Uint8Array | null,
): string {
  if (mime === RICHTEXT_MIME) {
    const blocks = decodeRichTextBody(mime, data);
    return blocks ? blocksToPlaintext(blocks) : "";
  }
  return decodeContent(mime, data);
}

/**
 * Serve the batch from the `room_activity` projection.
 *
 * Two round-trips for the whole page, neither growing with the number of
 * messages in it: one read of the reduced rows (latest message id + timestamp,
 * distinct authors by their newest message) and one for the board shape the
 * caller needs (kind, name, canonical parent, and the latest message's decoded
 * content).
 *
 * Returns `null` when the projection cannot answer the whole page — the table is
 * missing, or at least one requested room has no row — which sends the caller to
 * the live scan. A partially-projected answer is deliberately not assembled; see
 * `readRoomActivityProjection`.
 */
async function fetchProjectedRoomActivity(
  db: DbLike,
  roomIds: string[],
): Promise<Map<string, ThreadActivity> | null> {
  const projected = await readRoomActivityProjection(db, roomIds);
  if (!projected) return null;

  const ph = roomIds.map(() => "?").join(",");

  // Room shape + latest-message content, one row per room. The content columns
  // are the decoded message the board previews; `coalesce` picks the forwarded
  // original's for a legacy forward reference, which has none of its own.
  const roomRows = await db
    .query(
      `select cr.entity as room_id,
              cr.label as label,
              ci.name as name,
              p.head as parent_id,
              ra.latest_message_id as latest_message_id,
              coalesce(mc.mime_type, fc.mime_type) as mime_type,
              coalesce(mc.data, fc.data) as data,
              coalesce(a.tail, fa.tail) as author_did
         from comp_room cr
         left join comp_info ci on ci.entity = cr.entity
         left join edges p
                on p.tail = cr.entity and p.label = 'link'
               and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
         left join room_activity ra on ra.room_id = cr.entity
         left join entities m on m.id = ra.latest_message_id
         left join comp_content mc on mc.entity = m.id
         left join edges a on a.head = m.id and a.label = 'author'
         left join edges f on f.head = m.id and f.label = 'forward'
         left join comp_content fc on fc.entity = f.tail
         left join edges fa on fa.head = f.tail and fa.label = 'author'
        where cr.entity in (${ph})`,
    )
    .all<{
      room_id: string;
      label: string | null;
      name: string | null;
      parent_id: string | null;
      latest_message_id: string | null;
      mime_type: string | null;
      data: Buffer | Uint8Array | null;
      author_did: string | null;
    }>(...roomIds);

  // A requested id with no `comp_room` row is not a room at all — the caller
  // asked for something this projection has no board row for, so it cannot
  // answer the page.
  if (roomRows.length !== roomIds.length) return null;

  // Every author who can appear in the page's `latestMembers`, in one read
  // rather than one per room. Names/avatars come from the per-space `comp_info`;
  // `hydrateProfiles` in the caller then layers the global store over whatever
  // this finds, as it does for the scanned path.
  const memberDids = new Set<string>();
  for (const row of projected.values()) {
    for (const a of row.authors) memberDids.add(a.did);
  }
  const members = new Map<string, { name: string | null; avatar: string | null }>();
  if (memberDids.size > 0) {
    const dids = [...memberDids];
    const infoRows = await db
      .query(
        `select entity, name, avatar from comp_info
          where entity in (${dids.map(() => "?").join(",")})`,
      )
      .all<{ entity: string; name: string | null; avatar: string | null }>(...dids);
    for (const r of infoRows) members.set(r.entity, { name: r.name, avatar: r.avatar });
  }

  const out = new Map<string, ThreadActivity>();
  for (const row of roomRows) {
    const projection = projected.get(row.room_id)!;
    const author = row.author_did != null ? members.get(row.author_did) : undefined;

    const latestMessage: ThreadMessage | null =
      row.latest_message_id != null && row.author_did != null
        ? {
            id: row.latest_message_id,
            content: decodeBoardPreview(row.mime_type, row.data),
            author: {
              did: row.author_did,
              name: author?.name ?? null,
              avatar: author?.avatar ?? null,
            },
            timestamp:
              projection.latestAt != null
                ? new Date(projection.latestAt).toISOString()
                : null,
          }
        : null;

    out.set(row.room_id, {
      id: row.room_id,
      kind: row.label === "space.roomy.channel" ? "channel" : "thread",
      name: row.name,
      canonicalParent: row.parent_id,
      latestTimestamp:
        projection.latestAt != null
          ? new Date(projection.latestAt).toISOString()
          : null,
      latestMembers: projection.authors.slice(0, 3).map((a) => {
        const p = members.get(a.did);
        return { did: a.did, name: p?.name ?? null, avatar: p?.avatar ?? null };
      }),
      latestMessage,
    });
  }

  return out;
}
