/**
 * User thread activity helpers.
 *
 * Tracks threads the user has interacted with (sent a message or added a
 * reaction) and provides query support for the sidebar `activeThreads` in
 * `space.getMetadata`.
 *
 * All data lives in the read-state database (`user_thread_activity`),
 * which is appserver-owned and cannot be reconstructed from the event log.
 */

import type { DbLike } from "../db/types.ts";
import type { StreamDid, Ulid, UserDid } from "@roomy-space/sdk";
import { hydrateProfiles } from "./profileStore.ts";

/** How far back (in ms) to consider threads active. Default: 120 hours. */
export const ACTIVE_WINDOW_MS = 120 * 60 * 60 * 1000;

/** Maximum number of active threads to return per user+space. */
const MAX_ACTIVE_THREADS = 8;

/**
 * Upsert a user's activity in a thread.
 *
 * Called when the user sends a message, adds a reaction, or reads a thread.
 * This is a no-op if `threadId` is not actually a thread — the caller
 * is responsible for checking.
 */
export async function upsertUserThreadActivity(
  db: DbLike,
  userDid: string,
  threadId: string,
  timestamp: number,
): Promise<void> {
  await db.run(
    `insert into user_thread_activity (user_did, thread_id, last_active_at, updated_at)
     values (?, ?, ?, ?)
     on conflict(user_did, thread_id) do update set
       last_active_at = excluded.last_active_at,
       updated_at = excluded.updated_at`,
    userDid, threadId, timestamp, Date.now(),
  );
}

/**
 * Refresh thread activity when a new message arrives.
 *
 * Re-surfaces the thread in the sidebar for every user who is already
 * tracking it (has a `user_thread_activity` row — they wrote, reacted, or
 * read it), so a thread you've been active in reappears when someone else
 * posts — not only when you post. Also ensures the author is tracking it.
 */
export async function refreshThreadActivityOnMessage(
  db: DbLike,
  threadId: string,
  authorDid: string,
  timestamp: number,
): Promise<void> {
  const now = Date.now();
  await db.run(
    `update user_thread_activity
        set last_active_at = ?, updated_at = ?
      where thread_id = ?`,
    timestamp, now, threadId,
  );
  // Ensure the author is tracking it too.
  await upsertUserThreadActivity(db, authorDid, threadId, timestamp);
}

/**
 * Result shape for a single active thread entry in the sidebar.
 */
export interface ActiveThreadEntry {
  id: string;
  name: string | null;
  /** The parent channel ID this thread is canonically linked to. */
  canonicalParent: string | null;
  /** Latest message timestamp (ISO string), null if no messages. */
  latestTimestamp: string | null;
  /** Up to 3 most recent distinct participants. */
  latestMembers: Array<{ did: string; name: string | null; avatar: string | null }>;
  canRead: boolean;
  canWrite: boolean;
  unreadCount: number;
  lastRead: string | null;
}

/**
 * Resolve thread metadata (name, latest activity, recent participants) for
 * a batch of thread IDs. Returns a map keyed by thread ID.
 *
 * Reuses the same prepared statements as `listThreadActivity` in
 * `threadActivity.ts`. The caller is responsible for filtering by access.
 */
export async function resolveThreadsByIds(
  db: DbLike,
  threadIds: string[],
): Promise<Map<string, {
  name: string | null;
  latestTimestamp: string | null;
  latestMembers: Array<{ did: string; name: string | null; avatar: string | null }>;
  canonicalParent: string | null;
}>> {
  const result = new Map<string, {
    name: string | null;
    latestTimestamp: string | null;
    latestMembers: Array<{ did: string; name: string | null; avatar: string | null }>;
    canonicalParent: string | null;
  }>();

  if (threadIds.length === 0) return result;

  // Batch all four lookups into single `in (...)` queries instead of the
  // previous per-thread loop (4 round-trips × N threads). For the sidebar's
  // up-to-8 active threads that was ~32 round-trips to the per-space DB
  // worker per getMetadata request — a significant pool-saturation source
  // under load. Mirrors the batching already used by `listThreadActivity`.
  const ph = threadIds.map(() => "?").join(",");

  // Thread names
  const nameRows = await db
    .query(`select entity, name from comp_info where entity in (${ph})`)
    .all<{ entity: string; name: string | null }>(...threadIds);
  const nameMap = new Map(nameRows.map((r) => [r.entity, r.name]));

  // Latest timestamp per thread
  const latestRows = await db
    .query(
      `select e.room as room, max(cc.timestamp) as ts
         from entities e
         join comp_content cc on cc.entity = e.id
        where e.room in (${ph})
        group by e.room`,
    )
    .all<{ room: string; ts: number | null }>(...threadIds);
  const latestMap = new Map(latestRows.map((r) => [r.room, r.ts]));

  // Recent participants (up to 3 per thread). SQLite has no LIMIT per group,
  // so fetch all and take the top 3 per thread in JS (same approach as
  // `listThreadActivity`).
  const participantRows = await db
    .query(
      `select msg.room as room,
              author_e.tail as did,
              ci.name as name,
              ci.avatar as avatar,
              max(cc.timestamp) as ts
         from entities msg
         join comp_content cc on cc.entity = msg.id
         join edges author_e on author_e.head = msg.id and author_e.label = 'author'
         left join comp_info ci on ci.entity = author_e.tail
        where msg.room in (${ph})
        group by msg.room, author_e.tail
        order by msg.room, ts desc`,
    )
    .all<{ room: string; did: string; name: string | null; avatar: string | null; ts: number | null }>(...threadIds);
  const participantsMap = new Map<string, Array<{ did: string; name: string | null; avatar: string | null }>>();
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

  // Canonical parent (the link edge with canonical_parent=1)
  const parentRows = await db
    .query(
      `select tail, head from edges
        where tail in (${ph})
          and label = 'link'
          and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1`,
    )
    .all<{ tail: string; head: string }>(...threadIds);
  const parentMap = new Map(parentRows.map((r) => [r.tail, r.head]));

  for (const tid of threadIds) {
    const latest = latestMap.get(tid);
    result.set(tid, {
      name: nameMap.get(tid) ?? null,
      latestTimestamp:
        latest != null ? new Date(latest).toISOString() : null,
      latestMembers: participantsMap.get(tid) ?? [],
      canonicalParent: parentMap.get(tid) ?? null,
    });
  }

  // Resolve participant profiles from the global store (with an in-memory
  // cache). A user's profile entity lives in their own stream, not this
  // space's stream, so the per-space comp_info join above is null for
  // cross-stream users. The global `profiles` table is authoritative; the
  // per-space value (if any) acts as a fallback.
  const membersToHydrate: Array<{ did: string; name: string | null; avatar: string | null }> = [];
  for (const entry of result.values()) membersToHydrate.push(...entry.latestMembers);
  await hydrateProfiles(
    membersToHydrate,
    (m) => m.did,
    (m, p) => {
      if (p.name != null) m.name = p.name;
      if (p.avatar != null) m.avatar = p.avatar;
    },
  );

  return result;
}

/**
 * Query active threads for a user in a space, returning up to
 * `MAX_ACTIVE_THREADS` results.
 *
 * Step 1: Find candidate thread IDs from `user_thread_activity` (within the
 * activity window, not deleted, labeled as thread).
 * Step 2: Resolve metadata via `resolveThreadsByIds`.
 * Step 3 (caller): Filter by read access and distribute into channel objects.
 *
 * If the user has no rows for this space, runs a lazy backfill from messages
 * the user authored in threads within the activity window.
 */
export async function queryActiveThreads(
  readStateDb: DbLike,
  spaceDb: DbLike,
  userDid: string,
  spaceId: string,
): Promise<Array<{
  id: string;
  last_active_at: number;
}>> {
  const now = Date.now();
  const windowStart = now - ACTIVE_WINDOW_MS;

  // Lazy backfill: if no `user_thread_activity` rows exist for this user in
  // THIS space, seed from authored messages. `user_thread_activity` lives in
  // the read-state DB; the entity/room checks live in the per-space DB (Phase
  // 3 — entities moved out of the read-state DB).
  const myThreads = await readStateDb
    .query("select thread_id from user_thread_activity where user_did = ?")
    .all<{ thread_id: string }>([userDid]);
  let existingCount = 0;
  if (myThreads.length > 0) {
    const ids = myThreads.map((r) => r.thread_id);
    const ph = ids.map(() => "?").join(",");
    const row = await spaceDb
      .query(`select count(*) as count from entities where id in (${ph}) and stream_id = ?`)
      .get<{ count: number }>([...ids, spaceId]);
    existingCount = row?.count ?? 0;
  }
  if (existingCount === 0) {
    await backfillUserThreadActivity(readStateDb, spaceDb, userDid, spaceId, windowStart);
  }

  // Query active threads within the activity window. Two-step: fetch candidate
  // `user_thread_activity` rows from the read-state DB, then confirm each is a
  // non-deleted thread in this space via the per-space DB.
  const utaRows = await readStateDb
    .query(
      `select thread_id, last_active_at
         from user_thread_activity
        where user_did = ?
          and last_active_at > ?
        order by last_active_at desc
        limit ?`,
    )
    .all<{ thread_id: string; last_active_at: number }>([userDid, windowStart, MAX_ACTIVE_THREADS]);

  // Confirm which candidates are non-deleted threads in this space in a
  // single batched query instead of one per-thread round-trip to the
  // per-space DB worker (up to 8 round-trips per getMetadata request).
  const rows: Array<{ thread_id: string; last_active_at: number }> = [];
  if (utaRows.length > 0) {
    const cph = utaRows.map(() => "?").join(",");
    const confirmed = await spaceDb
      .query(
        `select e.id as id from entities e
           join comp_room cr on cr.entity = e.id
          where e.id in (${cph})
            and e.stream_id = ?
            and cr.label = 'space.roomy.thread'
            and coalesce(cr.deleted, 0) = 0`,
      )
      .all<{ id: string }>([...utaRows.map((r) => r.thread_id), spaceId]);
    const confirmedSet = new Set(confirmed.map((r) => r.id));
    // utaRows is already ordered by last_active_at desc and capped at
    // MAX_ACTIVE_THREADS, so filtering preserves order and the cap.
    for (const r of utaRows) {
      if (confirmedSet.has(r.thread_id)) rows.push(r);
    }
  }

  return rows.map((r) => ({
    id: r.thread_id,
    last_active_at: r.last_active_at,
  }));
}

/**
 * Backfill `user_thread_activity` from messages the user authored in threads
 * within the given window. This gives the user an immediate populated sidebar
 * without needing to write a new message first. Reads candidate threads from
 * the per-space DB (`spaceDb`), writes rows to the read-state DB
 * (`readStateDb`) — Phase 3: entities/content/edges are per-space.
 */
async function backfillUserThreadActivity(
  readStateDb: DbLike,
  spaceDb: DbLike,
  userDid: string,
  spaceId: string,
  windowStart: number,
): Promise<void> {
  const candidates = await spaceDb
    .query(
      `select e.room as room, max(cc.timestamp) as ts
         from entities e
         join comp_content cc on cc.entity = e.id
         join edges author_e on author_e.head = e.id and author_e.label = 'author'
         join comp_room cr on cr.entity = e.room and cr.label = 'space.roomy.thread'
        where author_e.tail = ?
          and e.stream_id = ?
          and cc.timestamp > ?
        group by e.room`,
    )
    .all<{ room: string; ts: number | null }>([userDid, spaceId, windowStart]);
  for (const c of candidates) {
    await readStateDb.run(
      `insert or ignore into user_thread_activity (user_did, thread_id, last_active_at, updated_at)
       values (?, ?, ?, ?)`,
      userDid, c.room, c.ts ?? windowStart, Date.now(),
    );
  }
}

/**
 * Check if a room is a thread (has comp_room.label = 'space.roomy.thread').
 */
export async function isThread(db: DbLike, roomId: string): Promise<boolean> {
  const row = await db
    .query(
      `select cr.label from comp_room cr where cr.entity = ?`,
    )
    .get<{ label: string }>([roomId]);
  return row?.label === "space.roomy.thread";
}

/**
 * Purge stale user_thread_activity rows older than the given timestamp.
 * Should be called periodically (e.g. once per hour) from a background timer.
 */
export async function purgeStaleThreadActivity(
  db: DbLike,
  olderThan: number,
): Promise<number> {
  const result = await (await db.prepare(
    `delete from user_thread_activity
     where last_active_at < ?`,
  )).run([olderThan]);
  return result.changes;
}
