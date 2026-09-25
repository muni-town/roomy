/**
 * `room_activity` read projection.
 *
 * `queries/threadActivity.ts:fetchRoomActivity` answers "what is each room's
 * latest message, its timestamp, and who has spoken recently" by reading
 * **every message in every room in scope** and reducing in JS — SQLite has no
 * `LIMIT` per group. Measured at 8000 messages it returns 8001 rows to keep 2,
 * and it is the reason `space.getThreads` moves 7 ms → 42 ms as a channel grows
 * (`perf/probe-projections.ts`).
 * It is O(rows in scope), it runs on every board read, and no cache absorbs it.
 *
 * This module maintains one row per room holding the reduced answer:
 *
 *   room_id           the room
 *   latest_message_id the newest message-shaped entity in it
 *   latest_at         that message's canonical timestamp
 *   recent_authors    JSON array of `{did, ts}`, one entry per author, ts =
 *                     that author's newest message — the input to the board's
 *                     "most recent participants" list
 *
 * Reads then cost O(rooms in scope) regardless of how many messages those rooms
 * hold, and the reduction runs once per write instead of once per read.
 *
 * ## Why this is safe to project
 *
 * Nothing here is an authorisation input: it is a summary of rows that live in
 * this same DB, so it cannot disagree with the event log the way a projected
 * `default_access` could (`roomAccessProjection.ts`). The only way to move it
 * is to add or remove a message, and both are handled below.
 * A wrong or missing row is also recoverable in both directions: the read path
 * falls back to the live scan, and every write path re-derives the affected
 * rooms from the live tables rather than accumulating deltas.
 *
 * ## Maintenance
 *
 * Like `room_access`, maintenance rides inside the per-event transaction
 * `applyBatch` already opens, so it costs no additional worker round-trip:
 *
 * | event          | live                       | backfill            |
 * |----------------|----------------------------|---------------------|
 * | createMessage  | merge the message in-place | invalidate the room |
 * | deleteMessage  | invalidate the room        | invalidate the room |
 * | moveMessages   | invalidate source + dest   | invalidate both     |
 *
 * "Invalidate" is a row DELETE, following the same rule as `room_access`: a
 * projection is never *populated* during rematerialisation, but a replayed
 * change must not leave a stale row behind. The live delete/move paths then
 * rebuild the affected rows from the post-event tables in the materialiser's
 * side-effect stage, which bounds the invalidation window to the few statements
 * between the chunk transaction and that stage.
 *
 * A create is merged in place rather than rebuilt because folding one author
 * into the existing list is O(1) in room size while a rebuild is O(room size) —
 * and messages are created far more often than they are deleted.
 */

import type { DbLike } from "../db/types.ts";
import { log } from "../log.ts";

/**
 * One author entry inside `recent_authors`.
 *
 * `ts` is that author's newest message time, and is null for a message with an
 * author but no content timestamp — the "x joined the space" system message the
 * join materialiser writes. The board still lists such an author (they have
 * spoken in the room), ordered last, matching the scan fallback.
 */
export interface RoomActivityAuthor {
  did: string;
  ts: number | null;
}

/** A room's projected activity, already parsed. */
export interface RoomActivitySummary {
  /** Newest message-shaped entity in the room, null when it has none. */
  latestMessageId: string | null;
  /** That message's canonical timestamp, null when it has none. */
  latestAt: number | null;
  /** Distinct authors by their newest message, newest first. */
  authors: RoomActivityAuthor[];
}

/**
 * The message-shaped rows of the rooms being rebuilt, reduced to what the
 * projection stores.
 *
 * "Message-shaped" is the definition `selectMessages` and
 * `rebuildActivityWindow` already use: an entity needs own content OR a
 * `forward` edge. The timestamp is the canonical one — `comp_content.timestamp`
 * for a normal message (the materialiser resolves the `timestampOverride`
 * extension for bridged messages into that column) and the forwarded original's
 * for a legacy forward reference, which carries no content of its own.
 *
 * The room set comes from `json_each(?)` rather than a generated `in (?, ?, …)`
 * list so every statement binds exactly ONE parameter: one shape for the
 * one-room and the many-room case alike, with no placeholder count to get wrong.
 *
 * Timestamps are deliberately NOT filtered here: an author's newest message may
 * have no content timestamp (a system message), and the scan fallback
 * lists that author anyway. The two consumers below differ accordingly — the
 * latest message must have a time, its authors need not.
 */
const ENTRIES_BY_ROOM_SQL = `
  select e.id as id,
         e.room as room,
         coalesce(a.tail, fa.tail) as did,
         coalesce(cc.timestamp, fcc.timestamp) as ts
    from entities e
    left join comp_content cc on cc.entity = e.id
    left join edges a  on a.head  = e.id and a.label  = 'author'
    left join edges f  on f.head  = e.id and f.label  = 'forward'
    left join comp_content fcc on fcc.entity = f.tail
    left join edges fa on fa.head = f.tail and fa.label = 'author'
   where e.room in (select room_id from rooms)
     and (cc.entity is not null or f.tail is not null)`;

/**
 * Rebuild a set of rooms from the live tables.
 *
 * Unconditional upsert (`excluded` wins), not a merge: a rebuild reads the
 * room's current contents in full, so it is the authoritative answer and must
 * not be merged against a row that may describe the pre-delete state.
 */
function rebuildRoomActivitySql(roomIds: readonly string[]): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: `
      with rooms(room_id) as (select value from json_each(?1)),
           entries as (${ENTRIES_BY_ROOM_SQL}),
           latest as (
             -- The room's newest message. Ties break by message id, matching
             -- the scan below (which keeps the first row seen at a given
             -- timestamp): when two messages share a millisecond (bridged
             -- messages carry sender-supplied times), both paths must pick the
             -- same one or a board could disagree with the fallback it is
             -- supposed to equal.
             select room, id, ts from (
               select room, id, ts,
                      row_number() over (partition by room order by ts desc, id desc) as rn
                 from entries
                where ts is not null
             ) where rn = 1
           ),
           authors as (
             -- Distinct authors and their newest message time — the same
             -- aggregate the scan fallback runs (group by room + author,
             -- taking max(timestamp)), so the member list, its order, and the
             -- 3-member cap it feeds all agree with it.
             --
             -- The tie-break is deliberately the AUTHOR DID, matching the
             -- scan's ordering (room, ts desc) over its author-grouped rows: two
             -- authors whose newest message shares a timestamp must sort the
             -- same way in both paths.
             select room, json_group_array(
                      json_object('did', did, 'ts', ts) order by ts desc, did asc
                    ) as recent_authors
               from (
                 select room, did, max(ts) as ts
                   from entries
                  where did is not null
                  group by room, did
               )
              group by room
           )
      insert into room_activity (room_id, latest_message_id, latest_at, recent_authors)
      select r.room_id, l.id, l.ts, coalesce(au.recent_authors, '[]')
        from rooms r
        left join latest  l  on l.room  = r.room_id
        left join authors au on au.room = r.room_id
      on conflict (room_id) do update set
        latest_message_id = excluded.latest_message_id,
        latest_at         = excluded.latest_at,
        recent_authors    = excluded.recent_authors
    `,
    params: [JSON.stringify(roomIds)],
  };
}

/**
 * Fold one just-materialised message into its room's row — O(1) in room size.
 *
 * The message's room, timestamp and author are re-read from the tables rather
 * than taken from the event, so this can only project what was actually written:
 * a message the materialiser rejected (no entity row, no content) leaves the
 * projection untouched instead of inventing a row for it.
 *
 * The latest-message fields only move forward (`excluded.latest_at >` the stored
 * one, id as the tie-break), matching the `max()` the rebuild takes over
 * canonical timestamps: a Discord-bridged message carrying an old
 * `timestampOverride` must not displace a newer one already recorded. The author
 * list has no such ordering problem — it is a per-author maximum, so an older
 * message can only add an author or raise their timestamp.
 *
 * Insert and update are one statement so they cannot take different code paths.
 */
function mergeRoomActivityFromMessageSql(messageId: string): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: `
      insert into room_activity (room_id, latest_message_id, latest_at, recent_authors)
      select e.room,
             e.id,
             coalesce(cc.timestamp, fcc.timestamp),
             case
               when coalesce(a.tail, fa.tail) is null then '[]'
               else json_array(json_object(
                 'did', coalesce(a.tail, fa.tail),
                 'ts',  coalesce(cc.timestamp, fcc.timestamp)
               ))
             end
        from entities e
        left join comp_content cc on cc.entity = e.id
        left join edges a  on a.head  = e.id and a.label  = 'author'
        left join edges f  on f.head  = e.id and f.label  = 'forward'
        left join comp_content fcc on fcc.entity = f.tail
        left join edges fa on fa.head = f.tail and fa.label = 'author'
       where e.id = ?
         and e.room is not null
         and (cc.entity is not null or f.tail is not null)
      on conflict (room_id) do update set
        latest_message_id = case
          -- The stored value moves only for a message that HAS a time, is newer
          -- than what is recorded, or ties it with a higher id — the same
          -- tie-break the rebuild's window function and the scan use.
          -- Nulls are checked explicitly: SQL null comparisons are neither true
          -- nor false, so a stored null (a room whose only message is a system
          -- row) must read as "nothing recorded yet" rather than blocking.
          when excluded.latest_at is not null
            and (room_activity.latest_at is null
                 or excluded.latest_at > room_activity.latest_at
                 or (excluded.latest_at = room_activity.latest_at
                     and excluded.latest_message_id > room_activity.latest_message_id))
            then excluded.latest_message_id
            else room_activity.latest_message_id
        end,
        -- Scalar max() returns NULL when ANY argument is NULL (unlike the
        -- aggregate), so the null cases are spelled out: a room whose only
        -- message is a system row records a null time and must still adopt the
        -- next message that has one.
        latest_at = case
          when room_activity.latest_at is null then excluded.latest_at
          when excluded.latest_at is null then room_activity.latest_at
          when excluded.latest_at > room_activity.latest_at then excluded.latest_at
          else room_activity.latest_at
        end,
        recent_authors = case
          when json_array_length(excluded.recent_authors) = 0
            then room_activity.recent_authors
          else (
            select coalesce(
                     json_group_array(json_object('did', did, 'ts', ts) order by ts desc, did asc),
                     '[]'
                   )
              from (
                -- Per-author maximum across the stored list and this message.
                -- max(ts) ignores nulls, so an author whose stored entry has
                -- no timestamp still gains one once they post a real message.
                select did, max(ts) as ts
                  from (
                    select json_extract(value, '$.did') as did,
                           json_extract(value, '$.ts')  as ts
                      from json_each(room_activity.recent_authors)
                    union all
                    select json_extract(value, '$.did'),
                           json_extract(value, '$.ts')
                      from json_each(excluded.recent_authors)
                  )
                 group by did
              )
          )
        end
    `,
    params: [messageId],
  };
}

/**
 * Invalidate (delete) rows for a set of rooms.
 *
 * Used for replay (see the maintenance table in the file header) and for the
 * live delete/move paths, where the row is dropped before the chunk's
 * side-effects rebuild it from the post-event tables. A dropped row only ever
 * costs a read its fallback, never its correctness.
 */
function invalidateRoomActivitySql(roomIds: readonly string[]): {
  sql: string;
  params: unknown[];
} {
  const ph = roomIds.map(() => "?").join(", ");
  return {
    sql: `delete from room_activity where room_id in (${ph})`,
    params: [...roomIds],
  };
}

/**
 * The projection-maintenance step for one event, to be appended to the per-event
 * transaction `applyBatch` already opens. `null` when the event cannot move a
 * room's latest message.
 */
export function maintainRoomActivity(
  event: Record<string, unknown>,
  isBackfill: boolean,
): { sql: string; params: unknown[] } | null {
  switch (event["$type"]) {
    case "space.roomy.message.createMessage.v0": {
      const id = event["id"];
      if (typeof id !== "string" || id === "") return null;
      if (isBackfill) {
        // Replay: invalidate the room the message lands in, resolved from the
        // row rather than the event so no room id has to be trusted.
        return {
          sql: `delete from room_activity
                 where room_id = (select room from entities where id = ?)`,
          params: [id],
        };
      }
      return mergeRoomActivityFromMessageSql(id);
    }

    case "space.roomy.message.deleteMessage.v0": {
      const room = event["room"];
      if (typeof room !== "string" || room === "") return null;
      return invalidateRoomActivitySql([room]);
    }

    // moveMessages: the room the message leaves and the room it lands in both
    // change. The destination is checked against the source because a
    // self-move changes nothing.
    case "space.roomy.message.moveMessages.v0": {
      const from = event["room"];
      const to = event["toRoomId"];
      const rooms: string[] = [];
      if (typeof from === "string" && from !== "") rooms.push(from);
      if (typeof to === "string" && to !== "" && to !== from) rooms.push(to);
      if (rooms.length === 0) return null;
      return invalidateRoomActivitySql(rooms);
    }

    default:
      return null;
  }
}

/** Rebuild the projection for `roomIds` from the live tables. */
export async function rebuildRoomActivity(
  db: DbLike,
  roomIds: readonly string[],
): Promise<void> {
  if (roomIds.length === 0) return;
  const { sql, params } = rebuildRoomActivitySql(roomIds);
  await db.run(sql, ...params);
}

/**
 * Parse the `recent_authors` JSON column, newest first. A malformed or legacy
 * value yields nothing rather than throwing: the column is written by this
 * module only, and an unreadable row must degrade to "no members" inside a
 * board read, not fail it.
 *
 * A null `ts` is kept (see `RoomActivityAuthor`) — dropping the entry would lose
 * an author who really has spoken in the room.
 */
function parseRecentAuthors(raw: string): RoomActivityAuthor[] {
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
 * Read the projection for `roomIds`.
 *
 * `null` means "no projection to read" — the table is absent (a sync adapter
 * whose schema predates it), or it holds no row for at least one requested room
 * (a blue-green rebuild, or a room whose row was just invalidated). Both are
 * indistinguishable to the caller and mean the same thing: fall back to the live
 * scan.
 *
 * A partially-hit page is deliberately NOT accepted. Mixing projected and
 * scanned rooms on one page would leave two code paths producing the same
 * response, which cannot be kept honest; requiring every room present makes "the
 * projection answered this page" a page-level fact the tests can assert against
 * the fallback for exact equality.
 */
export async function readRoomActivityProjection(
  db: DbLike,
  roomIds: readonly string[],
): Promise<Map<string, RoomActivitySummary> | null> {
  if (roomIds.length === 0) return null;
  const ph = roomIds.map(() => "?").join(", ");
  let rows: Array<{
    room_id: string;
    latest_message_id: string | null;
    latest_at: number | null;
    recent_authors: string;
  }>;
  try {
    rows = await db
      .query(
        `select room_id, latest_message_id, latest_at, recent_authors
           from room_activity
          where room_id in (${ph})`,
      )
      .all(...roomIds);
  } catch (err) {
    warnProjectionUnavailable(err);
    return null;
  }
  const out = new Map<string, RoomActivitySummary>();
  for (const row of rows) {
    out.set(row.room_id, {
      latestMessageId: row.latest_message_id,
      latestAt: row.latest_at,
      authors: parseRecentAuthors(row.recent_authors),
    });
  }
  if (out.size !== roomIds.length) return null;
  return out;
}

let warnedUnavailable = false;

/**
 * Log the first projection-unavailable error, then stay quiet.
 *
 * Exported because the read path's warm-on-miss wants the same one-shot warning
 * the projection's own reads produce — an unavailable table logs once per
 * process rather than once per request.
 */
export function warnProjectionUnavailable(err: unknown): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  log.warn(
    `[room_activity] projection unavailable; falling back to the live activity scan: ${err instanceof Error ? err.message : String(err)}`,
  );
}
