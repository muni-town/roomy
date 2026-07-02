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

import type { Database } from "bun:sqlite";

/**
 * Upsert a user's participation in a room: record (or refresh) the timestamp of
 * their latest message there. Called from `applyBundle` on every live
 * `createMessage`, using the effective author (override-author if present, to
 * match the `author` edge logic).
 */
export function upsertUserRoomParticipation(
  db: Database,
  userDid: string,
  roomId: string,
  timestamp: number,
): void {
  db.prepare(
    `insert into readstate.user_room_participation
       (user_did, room_id, last_message_at, updated_at)
     values (?, ?, ?, (unixepoch() * 1000))
     on conflict(user_did, room_id) do update set
       last_message_at = excluded.last_message_at,
       updated_at = excluded.updated_at`,
  ).run(userDid, roomId, timestamp);
}

/**
 * Whether the user has ever participated (sent a message) in the room.
 * The Engaged digest gate calls this before opening a digest batch.
 */
export function hasUserParticipated(
  db: Database,
  userDid: string,
  roomId: string,
): boolean {
  const row = db
    .query<{ n: number }, [string, string]>(
      "select 1 as n from readstate.user_room_participation where user_did = ? and room_id = ?",
    )
    .get(userDid, roomId);
  return row != null;
}

/**
 * Lazy backfill: seed `user_room_participation` for a user from messages they
 * authored in a space (all room types). Called on demand by the digest
 * evaluation path the first time we need participation data for a space, so
 * existing users get digests without sending a new message first. Analogous
 * to `backfillUserThreadActivity`.
 *
 * Uses the `author` edge (set by the message materialiser) to identify
 * authored messages, so it works regardless of authorOverride (the edge's
 * tail is the effective author).
 */
export function backfillUserRoomParticipation(
  db: Database,
  userDid: string,
  spaceId: string,
): void {
  db.prepare(
    `insert or ignore into readstate.user_room_participation
       (user_did, room_id, last_message_at, updated_at)
     select ?, e.room, max(cc.timestamp), (unixepoch() * 1000)
       from entities e
       join comp_content cc on cc.entity = e.id
       join edges author_e on author_e.head = e.id and author_e.label = 'author'
      where author_e.tail = ?
        and e.stream_id = ?
      group by e.room`,
  ).run(userDid, userDid, spaceId);
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
export function hasUserParticipatedInSpace(
  db: Database,
  userDid: string,
  spaceId: string,
  roomId: string,
): boolean {
  const key = `${userDid}\u0000${spaceId}`;
  if (!backfilledPairs.has(key)) {
    backfillUserRoomParticipation(db, userDid, spaceId);
    backfilledPairs.add(key);
  }
  return hasUserParticipated(db, userDid, roomId);
}

/** Reset the backfill cache (tests only). */
export function _resetParticipationBackfillCache(): void {
  backfilledPairs.clear();
}