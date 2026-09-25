/**
 * `room_access` read projection.
 *
 * `auth/access.ts:resolveRoom` answers "which space owns this room, what is its
 * canonical parent channel, and what access does each carry" with up to three
 * queries, and the room-listing handlers call it once per room — measured at
 * 36 of `room.getThreads`' ~50 DB round-trips (`perf/probe-projections.ts`).
 *
 * ## What is projected, and why only this
 *
 * The projection carries the **structural** half of that answer:
 * `space_id` and `parent_channel_id`. Those come from `entities.stream_id` and
 * the canonical `'link'` edge — the expensive part (the link lookup runs a
 * `json_extract` predicate and accounts for 13 of the 36 round-trips).
 *
 * `default_access` is deliberately **not** stored here; it is always read live
 * from `comp_room`, batched across the room ids and their parent ids.
 * `default_access` is a security input that any writer of `comp_room` can
 * change, and this table is only maintained on the live event path:
 * projections are never written during rematerialisation.
 * A replayed `updateRoom` inside a boot gap, or any out-of-band write, would
 * silently serve a stale access decision — a projection that is *wrong about
 * authorisation* is not worth the query it saves. Structure is safe to project
 * because it changes only through room/link lifecycle events, and a miss is
 * always recoverable (see below).
 *
 * ## Maintenance
 *
 * - **Live events** upsert the affected rows, as one extra statement inside the
 *   per-event transaction `applyBatch` already opens — zero additional worker
 *   round-trips, atomic with the write that dirtied it.
 * - **Rematerialisation** (backfill) DELETES the affected rows instead. A
 *   delete is invalidation, not population, so this respects "no projections
 *   during remat" while keeping a replayed structural change from leaving a
 *   stale row behind. The next read warms it from the replayed data.
 * - **Read miss** falls back to the live tables and warms the row it just
 *   derived, so a row left absent by a blue-green rebuild (or a missed event)
 *   heals on first access with no backfill.
 *
 * Every read fails soft: a handle without the table (a sync adapter whose
 * schema predates it) degrades to the live-table path rather than throwing,
 * because this is an optimisation and must never be a correctness dependency.
 */

import type { DbLike } from "../db/types.ts";
import { log } from "../log.ts";

/** The projectable structure of one room. */
export interface RoomAccessProjectionRow {
  room_id: string;
  space_id: string;
  parent_channel_id: string | null;
}

/**
 * `null` means "every room this event's statements touched" — recompute from
 * the per-space DB rather than from the event payload. Used by the synthetic
 * `spaceMeta` event, which materialises a whole channel tree at once.
 */
type AffectedRooms = string[] | "all_in_payload";

/**
 * Which rooms each event type can change, keyed by `$type`.
 *
 * Derived by reading the SDK materialisers rather than inferred: every event
 * that writes `entities.stream_id`/`entities.room` for a room, or writes a
 * canonical `'link'` edge, is listed, with its SDK source cited so the table
 * can be re-verified when an event is added.
 *
 * A missing entry is not a correctness hole — the read path warms on miss —
 * but it does leave a stale row until the next write to that room, so prefer
 * over-reporting: recomputing an unaffected room is idempotent.
 */
const AFFECTED_ROOMS_BY_EVENT: Record<string, AffectedRooms> = {
  // events/room.ts:60-77 — ensureEntity(stream_id) + comp_room insert
  "space.roomy.room.createRoom.v0": "all_in_payload",
  // events/room.ts:109-140 — may change the room kind (channel ↔ thread)
  "space.roomy.room.updateRoom.v0": "all_in_payload",
  // events/room.ts:145-168 — soft delete / restore
  "space.roomy.room.deleteRoom.v0": "all_in_payload",
  "space.roomy.room.restoreRoom.v0": "all_in_payload",
  // events/link.ts:26 — inserts the canonical 'link' edge (the parent channel)
  "space.roomy.link.createRoomLink.v0": "all_in_payload",
  // events/link.ts:80 — removes it
  "space.roomy.link.removeRoomLink.v0": "all_in_payload",
  // events/synthetic.ts:180-250 — inserts entities + comp_room for a whole tree
  "space.roomy.query.spaceMeta.v0": "all_in_payload",
};

/**
 * Room ids an event can affect, or `null` for "recompute from the DB". Returns
 * an empty array for events that cannot touch the projection, so the caller
 * skips the statement entirely.
 */
export function affectedRoomIds(event: Record<string, unknown>): string[] | null {
  const kind = event["$type"];
  if (typeof kind !== "string") return [];
  const scope = AFFECTED_ROOMS_BY_EVENT[kind];
  if (scope === undefined) return [];
  if (scope === "all_in_payload") return null;
  return scope;
}

/**
 * The upsert for an explicit set of room ids, written as a single statement so
 * it can run inside the per-event transaction the materialiser already opened.
 */
function upsertSql(roomIds: string[]): { sql: string; params: unknown[] } {
  const ph = roomIds.map(() => "?").join(", ");
  return {
    sql: `
      insert into room_access (room_id, space_id, parent_channel_id)
      select e.id,
             e.stream_id,
             p.head
        from entities e
        left join edges p
               on p.tail = e.id
              and p.label = 'link'
              and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
       where e.id in (${ph})
         and e.stream_id is not null
      on conflict (room_id) do update set
        space_id = excluded.space_id,
        parent_channel_id = excluded.parent_channel_id
    `,
    params: roomIds,
  };
}

/** The same upsert scoped to every room-shaped entity in a space. */
function upsertAllInSpaceSql(streamId: string): { sql: string; params: unknown[] } {
  return {
    sql: `
      insert into room_access (room_id, space_id, parent_channel_id)
      select e.id,
             e.stream_id,
             p.head
        from entities e
        join comp_room cr on cr.entity = e.id
        left join edges p
               on p.tail = e.id
              and p.label = 'link'
              and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
       where e.stream_id = ?
      on conflict (room_id) do update set
        space_id = excluded.space_id,
        parent_channel_id = excluded.parent_channel_id
    `,
    params: [streamId],
  };
}

/**
 * Invalidate (delete) projection rows for the rooms an event can have changed.
 *
 * Used for backfill/replay: a replayed structural change must not leave a stale
 * row, and populating during remat is explicitly out of scope. Deleting is the
 * cheap, correct middle ground — the next read warms from the replayed data.
 */
function invalidateSql(roomIds: string[]): { sql: string; params: unknown[] } {
  const ph = roomIds.map(() => "?").join(", ");
  return {
    sql: `delete from room_access where room_id in (${ph})`,
    params: roomIds,
  };
}

function invalidateAllInSpaceSql(streamId: string): { sql: string; params: unknown[] } {
  return {
    sql: `delete from room_access where space_id = ?`,
    params: [streamId],
  };
}

/**
 * Build the projection-maintenance step for one event, to be appended to the
 * chunk's per-event transaction. `isBackfill` selects invalidate over upsert.
 *
 * Returns `null` when the event cannot affect the projection.
 */
export function maintainRoomAccess(
  event: Record<string, unknown>,
  streamId: string,
  isBackfill: boolean,
): { sql: string; params: unknown[] } | null {
  const ids = affectedRoomIds(event);
  if (ids === null) {
    return isBackfill
      ? invalidateAllInSpaceSql(streamId)
      : upsertAllInSpaceSql(streamId);
  }
  if (ids.length === 0) return null;
  return isBackfill ? invalidateSql(ids) : upsertSql(ids);
}

/** Read the projection for one room. `null` on miss. Fails soft. */
export async function readRoomAccessProjection(
  db: DbLike,
  roomId: string,
): Promise<RoomAccessProjectionRow | null> {
  try {
    return await db
      .query(
        `select room_id, space_id, parent_channel_id
           from room_access
          where room_id = ?`,
      )
      .get<RoomAccessProjectionRow>(roomId);
  } catch (err) {
    warnUnavailable(err);
    return null;
  }
}

/** Read the projection for many rooms in one round-trip. Absent ids = misses. */
export async function readRoomAccessProjectionMany(
  db: DbLike,
  roomIds: string[],
): Promise<Map<string, RoomAccessProjectionRow>> {
  const out = new Map<string, RoomAccessProjectionRow>();
  if (roomIds.length === 0) return out;
  const ph = roomIds.map(() => "?").join(", ");
  try {
    const rows = await db
      .query(
        `select room_id, space_id, parent_channel_id
           from room_access
          where room_id in (${ph})`,
      )
      .all<RoomAccessProjectionRow>(...roomIds);
    for (const row of rows) out.set(row.room_id, row);
  } catch (err) {
    warnUnavailable(err);
  }
  return out;
}

/**
 * Whether the projection is queryable on this handle — checked before warming
 * so a handle without the table pays nothing for a write that would fail.
 * Not cached: it is one cheap statement, and per-space DBs are opened lazily
 * behind long-lived handles.
 */
export async function roomAccessProjectionAvailable(db: DbLike): Promise<boolean> {
  try {
    await db.query("select 1 from room_access limit 1").get<{ "1": number }>();
    return true;
  } catch (err) {
    warnUnavailable(err);
    return false;
  }
}

/**
 * Warm the projection for `roomIds` from the live tables.
 *
 * Called by the read path after a miss. Best-effort: a failure must never turn
 * a successful read into an error, so it is logged and swallowed — the caller
 * has already computed the answer it needs.
 */
export async function warmRoomAccessProjection(
  db: DbLike,
  roomIds: string[],
): Promise<void> {
  if (roomIds.length === 0) return;
  const { sql, params } = upsertSql(roomIds);
  try {
    await db.run(sql, ...params);
  } catch (err) {
    log.warn(
      `[room_access] warm failed for ${roomIds.length} room(s): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Log the first projection-unavailable error, then stay quiet. */
let warnedUnavailable = false;
function warnUnavailable(err: unknown): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  log.warn(
    `[room_access] projection unavailable; falling back to live access resolution: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Test helper: re-arm the one-shot warning. */
export function _resetRoomAccessProjectionWarning(): void {
  warnedUnavailable = false;
}
