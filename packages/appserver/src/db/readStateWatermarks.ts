/**
 * Repair read-state watermarks that name no message ordering key, and measure
 * how many are left.
 *
 * `read_positions.seen_up_to` stores an `entities.sort_idx` and is compared
 * against live `sort_idx` values by every unread computation: `updateSeen`
 * counts the messages after it, `decrementUnreadForRemovedMessages` decides
 * whether a removed message was still unread, and `decodeSeenUpTo` maps an
 * undecodable value to "no real watermark". A watermark that names no key is
 * therefore not a harmless stale value — the room reads as though the user had
 * never opened it.
 *
 * The v3 re-key (`spaceMigrations.ts`) moved the watermarks it could follow
 * through `sort_idx_prev`, the pre-clear keys, and dropped that table when it
 * finished. What it could not follow it counted and left. This pass is the
 * repair for that residue, and it is deliberately independent of the migration:
 * it re-derives the anchor from the keys the room holds NOW, so it works long
 * after `sort_idx_prev` is gone and on every boot thereafter.
 *
 * ## The anchor
 *
 * A watermark is re-anchored to the greatest `sort_idx` at or below it in its
 * own room — the last message the user could have seen. Three properties make
 * that the honest choice:
 *
 *   - It is a pure function of the stored value and the room's current keys, so
 *     the same input always produces the same output. Re-running the pass on a
 *     repaired row is a no-op: the anchor it wrote IS a key, and the greatest
 *     key at or below a key is itself.
 *   - It never invents unread messages. The alternative, resetting the row to
 *     "everything read" (what `updateSeen` does when handed no watermark at
 *     all), marks every message since as read. Measured across the residue this
 *     pass was written for, the newest key in every affected room sits at least
 *     one message past the stored position, so a reset would silently discard a
 *     real unread position in every one of those rooms.
 *   - It matches what the read path measures against. `seen_up_to` is a
 *     `sort_idx` by construction — both writers store one, `readStateSchema.sql`
 *     documents it as one — and `updateSeen` counts `sort_idx > ?`. Rows the
 *     materialiser never keyed (NULL `sort_idx`) are excluded by that
 *     comparison, so anchoring to the timeline key `coalesce(sort_idx, id)`
 *     instead would write a value no reader compares against and could count
 *     content rows the unread accounting has never counted.
 *
 * `unread_count` is recomputed from the new anchor in the same statement, which
 * is what `updateSeen` computes for an explicit watermark
 * (`select count(*) … where room = ? and sort_idx > ?`), so a repaired row is
 * indistinguishable from one the procedure wrote itself.
 *
 * ## What it cannot repair
 *
 * A watermark older than every key its room still holds — the messages it named
 * were all deleted, or the room was rebuilt empty — has no anchor. Those rows
 * are left byte-for-byte alone and counted, not guessed at.
 *
 * A row whose room belongs to a space this boot has no DB for — a room id from
 * another deployment, or one whose stream is no longer in the event log —
 * cannot be resolved against any key set. Those are counted separately, so a
 * fleet-wide drop in the unresolved figure cannot hide them.
 */

import { metrics } from "../metrics.ts";
import { log } from "../log.ts";
import type { DbLike } from "./types.ts";

/** Distinct (room, watermark) pairs resolved per statement against a space DB. */
const RESOLVE_BATCH = 500;
/** Room ids looked up per statement in the global entity→space index. */
const ATTRIBUTE_BATCH = 500;
/** Spaces examined at once. */
const DEFAULT_CONCURRENCY = 4;

/**
 * Read-state watermarks naming no message ordering key in their room.
 *
 * The pass sets it twice: to the count found as soon as every space has been
 * measured, then to the count still unresolved once the repairs are in. A
 * steady 0 means there is nothing left to re-anchor; the value between those
 * two writes is the residue as it stood before this pass.
 */
export const watermarksUnresolved = metrics.gauge(
  "roomy_readstate_watermarks_unresolved",
  "Read-state watermarks naming no message ordering key in their room. Set to the count found when the boot repair pass measures them, then to the count still unresolved once it has re-anchored what it can. Steady 0 means nothing is left to re-anchor.",
);
/**
 * Watermarks this process re-anchored. The one-off figure for a fleet that had
 * a residue is this counter's increase across the deploy that carried the
 * repair.
 */
export const watermarksRepaired = metrics.counter(
  "roomy_readstate_watermarks_repaired_total",
  "Read-state watermarks re-anchored to an ordering key their room still holds.",
);
watermarksUnresolved.set({}, 0);
watermarksRepaired.inc({}, 0);

export interface WatermarkSweepResult {
  /** Real watermarks (`seen_up_to` neither `''` nor `'0'`) in spaces examined. */
  examined: number;
  /** Of those, the ones that named no key in their room when measured. */
  found: number;
  /** Re-anchored to the greatest key their room holds at or below the watermark. */
  repaired: number;
  /** `found - repaired` — still naming nothing, because no key survived. */
  unresolved: number;
  /** Real watermarks whose owning space this boot could not examine. */
  unattributed: number;
  /** Spaces the pass could not read; their rows stay unresolved until a later boot. */
  failedSpaces: number;
}

/** One `read_positions` row this pass has to resolve. */
interface PendingRow {
  userDid: string;
  roomId: string;
  seenUpTo: string;
}

/** An update that moves a watermark onto a key its room still holds. */
interface Repair {
  userDid: string;
  roomId: string;
  seenUpTo: string;
  anchor: string;
  unreadCount: number;
}

/** What one space contributed: the residue it holds and the repairs for it. */
interface SpaceResult {
  spaceDid: string;
  /** Real watermarks in this space. */
  examined: number;
  /** Watermarks that named no key AND had no key at or below them to adopt. */
  unanchorable: number;
  repairs: Repair[];
}

/**
 * Resolve distinct (room, watermark) pairs against the space's live keys.
 *
 * One statement per {@link RESOLVE_BATCH} pairs: a CTE of the pairs joined to
 * two correlated subqueries, one for the anchor (`max(sort_idx)` at or below the
 * watermark) and one for the count after it. Both walk
 * `idx_entities_room_sort`, so a pair costs a seek rather than a scan of its
 * room.
 *
 * Deduplicated because a channel's watermark is one row per reader and a room
 * with N readers shares one resolution — the production residue is thousands of
 * rows over a few hundred rooms.
 */
async function resolveSpace(
  spaceDb: DbLike,
  rows: readonly PendingRow[],
): Promise<Map<string, { anchor: string | null; unreadCount: number }>> {
  const resolved = new Map<string, { anchor: string | null; unreadCount: number }>();
  const pairs = new Map<string, { roomId: string; seenUpTo: string }>();
  for (const row of rows) {
    pairs.set(`${row.roomId}\u0000${row.seenUpTo}`, {
      roomId: row.roomId,
      seenUpTo: row.seenUpTo,
    });
  }

  const unique = [...pairs.values()];
  for (let i = 0; i < unique.length; i += RESOLVE_BATCH) {
    const batch = unique.slice(i, i + RESOLVE_BATCH);
    const values = batch.map(() => "(?, ?)").join(",");
    const params = batch.flatMap((p) => [p.roomId, p.seenUpTo]);
    const found = await spaceDb
      .query(
        `with wm(room, w) as (values ${values}),
              anchored(room, w, anchor) as (
                select wm.room, wm.w,
                       (select max(e.sort_idx) from entities e
                         where e.room = wm.room and e.sort_idx <= wm.w)
                  from wm
              )
         select a.room as room, a.w as w, a.anchor as anchor,
                (select count(*) from entities e
                  where e.room = a.room and e.sort_idx > a.anchor) as unread_count
           from anchored a`,
      )
      .all<{ room: string; w: string; anchor: string | null; unread_count: number }>(...params);
    for (const r of found) {
      resolved.set(`${r.room}\u0000${r.w}`, {
        anchor: r.anchor,
        unreadCount: r.anchor === null ? 0 : r.unread_count,
      });
    }
  }
  return resolved;
}

/**
 * Measure one space and resolve the watermarks in it that name no key.
 *
 * Rows that are not in `resolved` at all were never asked about, which cannot
 * happen for a space whose own rows were scanned — the pairs come from the same
 * list. `anchor === null` is the honest "no key at or below this watermark
 * survives here": left byte-for-byte alone and counted. `anchor === seenUpTo`
 * is a watermark that already names a key, which a healthy row is; it is
 * skipped so the pass touches nothing that was never its business.
 */
async function measureSpace(
  spaceDb: DbLike,
  spaceDid: string,
  rows: readonly PendingRow[],
): Promise<SpaceResult> {
  const resolved = await resolveSpace(spaceDb, rows);
  const result: SpaceResult = {
    spaceDid,
    examined: rows.length,
    unanchorable: 0,
    repairs: [],
  };
  for (const row of rows) {
    const r = resolved.get(`${row.roomId}\u0000${row.seenUpTo}`);
    if (!r || r.anchor === null) {
      result.unanchorable++;
      continue;
    }
    if (r.anchor === row.seenUpTo) continue;
    result.repairs.push({
      userDid: row.userDid,
      roomId: row.roomId,
      seenUpTo: row.seenUpTo,
      anchor: r.anchor,
      unreadCount: r.unreadCount,
    });
  }
  return result;
}

/**
 * Re-anchor the read-state watermarks in `spaceDids` that name no ordering key,
 * and publish what was found and what is left.
 *
 * Two phases over one pass: measure every space, then write the repairs.
 * Reading the whole picture before writing any of it is what lets the gauge
 * publish the residue as it actually stood, rather than a partially-repaired
 * sample of it.
 *
 * A no-op on adapters that do not route the read-state DB or per-space DBs
 * (`:memory:` sync test adapters), where there is nothing to re-anchor.
 *
 * Idempotent. A repaired watermark IS a key, so a second pass resolves it to
 * itself and writes nothing.
 */
export async function sweepReadStateWatermarks(
  db: DbLike,
  spaceDids: readonly string[],
  opts: { concurrency?: number } = {},
): Promise<WatermarkSweepResult> {
  const readState = db.readState?.();
  const forSpace = db.forSpace?.bind(db);
  if (!readState || !forSpace) {
    return {
      examined: 0,
      found: 0,
      repaired: 0,
      unresolved: 0,
      unattributed: 0,
      failedSpaces: 0,
    };
  }

  // One scan of the read-state table for the whole fleet. The residue is small
  // — a watermark is one row per reader per room — but the table also holds a
  // lazily-created `'0'` row for every (user, room) ever queried, which this
  // filter drops. Asking each space DID in turn would instead scan the whole
  // table once per space.
  const rows = await readState
    .query(
      `select user_did, room_id, space_did, seen_up_to
         from read_positions
        where seen_up_to <> '' and seen_up_to <> '0'`,
    )
    .all<{ user_did: string; room_id: string; space_did: string; seen_up_to: string }>();

  // `space_did` is written by the materialiser, not by the read path, so a row
  // a user's own `updateSeen` or a lazily-created position wrote carries an
  // empty one. The room still belongs to exactly one space, and the global
  // `entity_space` index says which — the same index `openSpaceDbForEntity`
  // resolves a room through. Without this the rows most likely to be stale (a
  // read position the user themselves moved) would be the ones no per-space
  // pass can reach.
  const unknown = rows.filter((r) => r.space_did === "");
  const roomSpace = new Map<string, string>();
  if (unknown.length > 0 && db.global) {
    const rooms = [...new Set(unknown.map((r) => r.room_id))];
    const global = db.global();
    for (let i = 0; i < rooms.length; i += ATTRIBUTE_BATCH) {
      const batch = rooms.slice(i, i + ATTRIBUTE_BATCH);
      const found = await global
        .query(
          `select entity_id, space_did from entity_space
            where entity_id in (${batch.map(() => "?").join(",")})`,
        )
        .all<{ entity_id: string; space_did: string }>(...batch);
      for (const r of found) roomSpace.set(r.entity_id, r.space_did);
    }
  }

  const known = new Set(spaceDids);
  const bySpace = new Map<string, PendingRow[]>();
  let unattributed = 0;
  for (const r of rows) {
    const spaceDid = r.space_did === "" ? roomSpace.get(r.room_id) : r.space_did;
    // A room this boot has no DB for — one whose stream is not in the event log,
    // or whose id the index does not carry — cannot be resolved against any key
    // set. Counted rather than folded into the residue: it is invisible to a
    // per-space pass and would otherwise vanish from the figure.
    if (spaceDid === undefined || !known.has(spaceDid)) {
      unattributed++;
      continue;
    }
    const list = bySpace.get(spaceDid);
    const pending = { userDid: r.user_did, roomId: r.room_id, seenUpTo: r.seen_up_to };
    if (list) list.push(pending);
    else bySpace.set(spaceDid, [pending]);
  }

  const spaces = [...bySpace.entries()];
  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, spaces.length),
  );

  // ── Phase 1: measure every space. Nothing is written yet, so `found` is the
  // residue as it stood rather than what survived an interrupted repair.
  const measured: SpaceResult[] = [];
  let found = 0;
  let failedSpaces = 0;
  let nextIndex = 0;
  const measure = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= spaces.length) return;
      const [spaceDid, spaceRows] = spaces[index]!;
      try {
        const result = await measureSpace(forSpace(spaceDid), spaceDid, spaceRows);
        found += result.repairs.length + result.unanchorable;
        measured.push(result);
      } catch (err) {
        // One unreadable space must not abandon the pass: every space is
        // independent, and this one's rows are still unresolved the next time
        // the pass reaches them.
        failedSpaces++;
        log.warn(
          "startup",
          `read-state watermark scan failed for ${spaceDid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  if (spaces.length > 0) {
    await Promise.all(Array.from({ length: concurrency }, measure));
  }

  // The residue as measured, published before the repair moves any of it. A
  // scrape between the two writes reads the pre-repair figure; a scrape after
  // them reads what is left.
  watermarksUnresolved.set({}, found);

  // ── Phase 2: write. One transaction per space, so its repairs either all
  // land or none do.
  let repaired = 0;
  const applyNext = { i: 0 };
  const apply = async (): Promise<void> => {
    for (;;) {
      const index = applyNext.i++;
      if (index >= measured.length) return;
      const { spaceDid, repairs } = measured[index]!;
      if (repairs.length === 0) continue;
      try {
        await readState.transaction(
          repairs.map((r) => ({
            type: "run" as const,
            // `seen_up_to` is part of the predicate, not only a value: two
            // boots racing the same repair must not overwrite a watermark the
            // user has moved in between with an anchor derived from the value
            // it held before.
            sql: "update read_positions set seen_up_to = ?, unread_count = ?, updated_at = (unixepoch() * 1000) where user_did = ? and room_id = ? and seen_up_to = ?",
            params: [r.anchor, r.unreadCount, r.userDid, r.roomId, r.seenUpTo],
          })),
        );
        repaired += repairs.length;
      } catch (err) {
        log.warn(
          "startup",
          `read-state watermark repair failed for ${spaceDid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  if (measured.length > 0) {
    await Promise.all(Array.from({ length: concurrency }, apply));
  }

  watermarksRepaired.inc({}, repaired);
  const unresolved = found - repaired;
  watermarksUnresolved.set({}, unresolved);

  // A line per affected space, then the fleet summary. The gauge says how much
  // is left; only these say where, which is what a repair is chased with.
  let examined = 0;
  for (const space of measured) {
    examined += space.examined;
    if (space.repairs.length === 0 && space.unanchorable === 0) continue;
    log.warn(
      "startup",
      `read-state watermarks for ${space.spaceDid}: ${space.repairs.length + space.unanchorable} of ${space.examined} named no ordering key, ${space.repairs.length} re-anchored, ${space.unanchorable} with no anchor`,
    );
  }
  if (found > 0 || unattributed > 0 || failedSpaces > 0) {
    const summary =
      `read-state watermarks: ${found} of ${examined} examined named no ordering key, ` +
      `${repaired} re-anchored, ${unresolved} with no anchor` +
      (unattributed > 0 ? `, ${unattributed} not attributable to a space` : "") +
      (failedSpaces > 0 ? `, ${failedSpaces} space(s) unreadable` : "");
    if (unresolved > 0 || unattributed > 0 || failedSpaces > 0) log.warn("startup", summary);
    else log.info("startup", summary);
  }

  return {
    examined,
    found,
    repaired,
    unresolved,
    unattributed,
    failedSpaces,
  };
}
