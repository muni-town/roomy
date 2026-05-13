/**
 * Helper to look up pre-computed unread counts from the readstate database.
 *
 * All unread data is read directly from the `unread_count` column — no
 * COUNT(*) against entities. This is O(1) per room.
 */

import type { Database } from "bun:sqlite"

export interface ReadPosition {
  unreadCount: number
  lastRead: string | null // ISO datetime derived from sort_idx
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
export function ensureReadPositions(
  db: Database,
  userDid: string,
  roomIds: string[]
): void {
  if (roomIds.length === 0) return

  const now = Date.now()
  const insert = db.prepare(
    `insert into readstate.read_positions (user_did, room_id, seen_up_to, unread_count, updated_at)
     values (?, ?, coalesce(
       (select max(sort_idx) from entities where room = ?), '0'
     ), 0, ?)
     on conflict(user_did, room_id) do nothing`
  )

  for (const roomId of roomIds) {
    insert.run(userDid, roomId, roomId, now)
  }

  console.log("ensured read positions for", roomIds)
}

/**
 * Look up the read position for a single (user, room) pair.
 * Lazily creates the row if it doesn't exist yet.
 */
export function getReadPosition(
  db: Database,
  userDid: string,
  roomId: string
): ReadPosition {
  ensureReadPositions(db, userDid, [roomId])

  const row = db
    .query<
      { unread_count: number; seen_up_to: string },
      [string, string]
    >("select unread_count, seen_up_to from readstate.read_positions where user_did = ? and room_id = ?")
    .get(userDid, roomId)

  return {
    unreadCount: row?.unread_count ?? 0,
    lastRead: null
  }
}

/**
 * Look up read positions for multiple rooms at once.
 * Returns a Map<roomId, ReadPosition>. Rooms without a row get the default.
 *
 * Calls ensureReadPositions first so that rows are lazily created for any
 * rooms the user hasn't queried before.
 */
export function getReadPositions(
  db: Database,
  userDid: string,
  roomIds: string[]
): Map<string, ReadPosition> {
  const result = new Map<string, ReadPosition>()

  if (roomIds.length === 0) return result

  // Lazily create rows for any rooms that don't have one yet.
  ensureReadPositions(db, userDid, roomIds)

  // Batch query. For the small number of rooms in a sidebar (typically < 50),
  // individual lookups via a prepared statement are fine.
  const stmt = db.prepare<
    { room_id: string; unread_count: number; seen_up_to: string },
    [string, string]
  >(
    "select room_id, unread_count, seen_up_to from readstate.read_positions where user_did = ? and room_id = ?"
  )

  for (const roomId of roomIds) {
    const row = stmt.get(userDid, roomId)
    result.set(roomId, {
      unreadCount: row?.unread_count ?? 0,
      lastRead: null
    })
  }

  return result
}

/**
 * Sum unread counts across all rooms the user has read positions for in a
 * given space. This is used for the per-space unreadCount in getSpaces.
 *
 * Calls ensureSpaceReadPositions first so that rows are lazily created.
 */
export function getSpaceUnreadCount(
  db: Database,
  userDid: string,
  spaceId: string
): number {
  ensureSpaceReadPositions(db, userDid, spaceId)

  const row = db
    .query<{ total: number }, [string, string]>(
      `select coalesce(sum(rp.unread_count), 0) as total
         from readstate.read_positions rp
         join entities e on e.id = rp.room_id
        where rp.user_did = ?
          and e.stream_id = ?`
    )
    .get(userDid, spaceId)

  return row?.total ?? 0
}

/**
 * Ensure read_positions rows exist for a user across all rooms in a space.
 */
function ensureSpaceReadPositions(
  db: Database,
  userDid: string,
  spaceId: string
): void {
  const roomIds = db
    .query<{ id: string }, [string]>(
      `select e.id from entities e
         join comp_room cr on cr.entity = e.id
        where e.stream_id = ?
          and cr.label = 'space.roomy.channel'
          and coalesce(cr.deleted, 0) = 0`
    )
    .all(spaceId)
    .map((r) => r.id)

  ensureReadPositions(db, userDid, roomIds)
}
