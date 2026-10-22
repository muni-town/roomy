/**
 * Each room's newest message key, for a whole set of rooms in one statement.
 *
 * `read_positions.seen_up_to` is an `entities.sort_idx`, so "nothing unread" is
 * the greatest key the room holds. Two callers need that value for many rooms
 * at once — the sidebar's read-position anchor (`queries/readPositions.ts`) and
 * the one-off anchor of placeholder read positions
 * (`readStatePositionsMigration.ts`) — and the sidebar runs it on every
 * `space.getMetadata`, so it cannot walk each room's entities. The statement
 * below is one correlated seek per room, bounded on `idx_entities_room_sort`,
 * rather than `max(sort_idx) group by room`, which visits every entity of every
 * room in the list.
 *
 * `sort_idx is not null` keeps the seek bounded: an entity the materialiser
 * never keyed sorts below every real key, so excluding it changes no answer,
 * and the predicate lets SQLite seek past a room's NULL keys instead of walking
 * them.
 */

import type { DbLike } from "./types.ts";

/**
 * One row per room in the `json_each` list, `newest` null where the room holds
 * no keyed entity.
 */
export const newestSortIdxByRoomSql = `select r.value as room_id,
         (select sort_idx
            from entities
           where room = r.value and sort_idx is not null
           order by sort_idx desc
           limit 1) as newest
    from json_each(?1) r`;

/**
 * Resolve {@link newestSortIdxByRoomSql} for `roomIds`, keyed by room id. A
 * room with no keyed entity maps to null.
 */
export async function newestSortIdxByRoom(
  spaceDb: DbLike,
  roomIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (roomIds.length === 0) return new Map();
  const rows = await spaceDb
    .query(newestSortIdxByRoomSql)
    .all<{ room_id: string; newest: string | null }>(JSON.stringify(roomIds));
  return new Map(rows.map((r) => [r.room_id, r.newest]));
}
