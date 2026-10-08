/**
 * User room participation store, backed by the read-state DB.
 *
 * Tracks "the user has sent a message in this room" — generalised across all
 * room types (channels + threads), keyed by `(user_did, room_id)`. The Engaged
 * digest gate uses this to restrict prompts to rooms you've spoken in, so a
 * busy room you've never participated in never generates a digest.
 *
 * State lives in the read-state DB (not the materialisation DB) so it
 * survives materialisation resets — see `db/readStateDb.ts`. It is distinct
 * from `user_thread_activity` (thread-only, owned by the sidebar) per the
 * web-push plan's recommendation (open question #1 → general table).
 */

import type { DbLike } from "../db/types.ts";
import { readRoomActivityProjectionRows } from "./roomActivityProjection.ts";

/**
 * Upsert a user's participation in a room: record (or refresh) the timestamp of
 * their latest message there. Called from `applyBundle` on every live
 * `createMessage`, using the effective author (override-author if present, to
 * match the `author` edge logic).
 */
export async function upsertUserRoomParticipation(
  db: DbLike,
  userDid: string,
  roomId: string,
  timestamp: number,
): Promise<void> {
  await db.run(
    `insert into user_room_participation
       (user_did, room_id, last_message_at, updated_at)
     values (?, ?, ?, (unixepoch() * 1000))
     on conflict(user_did, room_id) do update set
       last_message_at = excluded.last_message_at,
       updated_at = excluded.updated_at`,
    userDid,
    roomId,
    timestamp,
  );
}

/**
 * Whether the user has ever participated (sent a message) in the room.
 * The Engaged digest gate calls this before opening a digest batch.
 */
export async function hasUserParticipated(
  db: DbLike,
  userDid: string,
  roomId: string,
): Promise<boolean> {
  const row = await db.query(
    "select 1 as n from user_room_participation where user_did = ? and room_id = ?",
  ).get<{ n: number }>(userDid, roomId);
  return row != null;
}

/**
 * Lazy backfill: seed `user_room_participation` for a user from the rooms they
 * have authored a message in. Called on demand by the digest evaluation path
 * the first time we need participation data for a space, so existing users get
 * digests without sending a new message first. Analogous to
 * `backfillUserThreadActivity`.
 *
 * Candidates come from `authorRooms` below; rows are written to the read-state
 * DB.
 */
export async function backfillUserRoomParticipation(
  readStateDb: DbLike,
  spaceDb: DbLike,
  userDid: string,
  spaceId: string,
): Promise<void> {
  const candidates = await authorRooms(spaceDb, userDid, spaceId);
  for (const c of candidates) {
    await readStateDb.run(
      `insert or ignore into user_room_participation
         (user_did, room_id, last_message_at, updated_at)
       values (?, ?, ?, (unixepoch() * 1000))`,
      userDid,
      c.room,
      c.ts ?? Date.now(),
    );
  }
}

/**
 * The rooms `userDid` has authored a message in, with their newest message
 * time.
 *
 * The candidates are the rooms the user's `author` edges point at, which an
 * index answers directly: 15 ms on a space with 120k messages and 10k of them
 * the user's, against 29-91 ms for the scan of every authored message that it
 * replaces. The `author` edge is what the message materialiser sets, so an
 * authorOverride is honoured here as it was before.
 *
 * Two of the three columns (`room`, `last_message_at`) come from that edge and
 * `entities`; only the timestamp is projected, so it is read from
 * `room_activity` for exactly the candidate rooms. The projection is read
 * without warming: warming is a rebuild, and a rebuild of a space's rooms
 * measured 458 ms against this path's 15 ms. A candidate the projection cannot
 * answer for therefore keeps the scan's timestamp for that one room.
 */
async function authorRooms(
  spaceDb: DbLike,
  userDid: string,
  spaceId: string,
): Promise<Array<{ room: string; ts: number | null }>> {
  const candidates = await spaceDb
    .query(
      `select distinct e.room as room
         from edges author_e
         join entities e on e.id = author_e.head
        where author_e.label = 'author'
          and author_e.tail = ?
          and e.stream_id = ?
          and e.room is not null`,
    )
    .all<{ room: string }>([userDid, spaceId]);
  if (candidates.length === 0) return [];

  const roomIds = candidates.map((c) => c.room);
  const projected = await readRoomActivityProjectionRows(spaceDb, roomIds);
  const out: Array<{ room: string; ts: number | null }> = [];
  const unresolved: string[] = [];
  for (const room of roomIds) {
    const author = projected?.rows.get(room)?.authors.find((a) => a.did === userDid);
    if (author) out.push({ room, ts: author.ts });
    else unresolved.push(room);
  }
  if (unresolved.length > 0) {
    out.push(...(await newestPerRoom(spaceDb, userDid, unresolved)));
  }
  return out;
}

/** The user's newest message time in each of `roomIds`, read from the messages. */
async function newestPerRoom(
  spaceDb: DbLike,
  userDid: string,
  roomIds: readonly string[],
): Promise<Array<{ room: string; ts: number | null }>> {
  return await spaceDb
    .query(
      `select e.room as room, max(cc.timestamp) as ts
         from entities e
         join comp_content cc on cc.entity = e.id
         join edges author_e on author_e.head = e.id and author_e.label = 'author'
        where author_e.tail = ?
          and e.room in (select value from json_each(?))
        group by e.room`,
    )
    .all<{ room: string; ts: number | null }>([userDid, JSON.stringify(roomIds)]);
}

/**
 * Process-lifetime cache of `${userDid}:${spaceId}` pairs already backfilled,
 * so the hot per-message digest path doesn't re-run the backfill query for a
 * non-participant on every single message. Bounded by process lifetime (single
 * node); cleared by {@link _resetParticipationBackfillCache} for tests.
 */
const backfilledPairs = new Set<string>();

/**
 * Ensure participation has been backfilled for `(userDid, spaceId)` at most
 * once per process lifetime, then report whether the user has participated in
 * `roomId`. The digest gate calls this. After the first backfill for a pair,
 * subsequent calls are just a cheap PK lookup.
 */
export async function hasUserParticipatedInSpace(
  readStateDb: DbLike,
  spaceDb: DbLike,
  userDid: string,
  spaceId: string,
  roomId: string,
): Promise<boolean> {
  const key = `${userDid}\u0000${spaceId}`;
  if (!backfilledPairs.has(key)) {
    await backfillUserRoomParticipation(readStateDb, spaceDb, userDid, spaceId);
    backfilledPairs.add(key);
  }
  return hasUserParticipated(readStateDb, userDid, roomId);
}


/** Reset the backfill cache (tests only). */
export function _resetParticipationBackfillCache(): void {
  backfilledPairs.clear();
}
