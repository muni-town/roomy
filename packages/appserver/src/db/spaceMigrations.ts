/**
 * Async per-space data migrations.
 *
 * A per-space schema bump upgrades the DB in place: the worker applies the
 * structural `up`s when it opens the DB (`spaceVersions.ts`), and this module
 * runs the `kind: "data"` tasks from the boot runner, one per stream, against
 * the space's own DB plus the event log. That replaces the previous
 * "every bump replays every space from the log" behaviour; the blue-green
 * rebuild is now the fallback for a migration that fails, not the default
 * (`streams/reMaterialize.ts`).
 *
 * Completion is stamped per space, in `space_schema_migrations` inside the
 * space DB, only after a task succeeds in full. Tasks must be idempotent: if
 * the process exits midway the null marker remains and the task is retried on
 * the next boot.
 */
import { decode } from "@atcute/cbor";
import type { Event, StreamDid, StreamIndex } from "@roomy-space/sdk";
import type { DbLike } from "./types.ts";
import {
  SPACE_SCHEMA_VERSION,
  spaceMigrationEntry,
  type SpaceAsyncVersion,
} from "./spaceVersions.ts";
import { messageSortIdxKey } from "../materialization/sortIdx.ts";
import { openReadStateDb } from "./db.ts";
import { log } from "../log.ts";

/** Rows decoded per round-trip when scanning the log. */
const SCAN_CHUNK = 1_000;
/** Statements per migration transaction. */
const APPLY_CHUNK = 500;

/**
 * A migration cannot reproduce what a full rebuild would produce. The caller
 * abandons the in-place upgrade and takes the blue-green rebuild path for this
 * space.
 */
export class SpaceMigrationNeedsRebuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaceMigrationNeedsRebuildError";
  }
}

interface RawEvent {
  idx: number;
  user: string;
  payload: Uint8Array;
  received_at: number | null;
  created_at: number | null;
}

/**
 * One `space.roomy.message.reorderMessage.v0` anywhere in the log.
 *
 * The scan cannot rely on `stream_events.event_type`: the column was added
 * after the table existed and old rows were never backfilled, so a reorder
 * could hide behind a NULL. Rows that do carry a type are filtered on it, and
 * only the rest are decoded — the common case for a space created after the
 * column existed is a handful of decodes.
 */
async function findReorderEvent(
  db: DbLike,
  streamDid: StreamDid,
): Promise<boolean> {
  let cursor = -1;
  for (;;) {
    const rows = await db
      .query(
        `select idx, payload from stream_events
          where stream_id = ? and idx > ?
            and (event_type is null or event_type = 'space.roomy.message.reorderMessage.v0')
          order by idx limit ?`,
      )
      .all<{ idx: number; payload: Uint8Array }>(streamDid, cursor, SCAN_CHUNK);
    if (rows.length === 0) return false;
    for (const row of rows) {
      const event = decode(row.payload) as Event;
      if (event.$type === "space.roomy.message.reorderMessage.v0") return true;
    }
    cursor = rows[rows.length - 1]!.idx;
  }
}

/**
 * The read-state handle a data migration needs, resolved lazily.
 *
 * The read-state DB holds values derived from `entities.sort_idx` (the
 * `read_positions.seen_up_to` watermark), so a task that re-keys those entities
 * has to re-anchor those copies in the same pass — otherwise the space and the
 * read-state disagree about what a stored key means.
 *
 * `readState` is absent on adapters that don't route it (sync test adapters),
 * in which case there is nothing to re-anchor. The global `openReadStateDb()`
 * fallback covers the boot path, which reaches the pool through `PooledDatabase`
 * — a router that declares the seams but does not spread them onto its
 * prototype, so feature detection alone would silently skip the re-anchor.
 */
function createReadStateResolver(db: DbLike): () => DbLike | undefined {
  let resolved: DbLike | undefined;
  return () => {
    if (resolved !== undefined) return resolved;
    if (db.readState) return (resolved = db.readState());
    try {
      resolved = openReadStateDb();
    } catch {
      resolved = undefined;
    }
    return resolved;
  };
}

/**
 * Move this space's read-state watermarks onto the keys the re-key produced.
 *
 * `seen_up_to` is a stored `entities.sort_idx` (`readStateSchema.sql`) —
 * `updateSeen` writes `max(sort_idx)` for the room, or the `sort_idx` of the
 * message its `seenUpTo` names — and it is compared against live `sort_idx`
 * values in two places: `updateSeen` counts the messages after it, and
 * `decrementUnreadForRemovedMessages` decides whether a removed message was
 * still unread. A re-key that does not follow it leaves the watermark naming a
 * key no entity carries, so every message in the room compares past it.
 *
 * The old key is not recomputable — it was this server's arrival clock on the
 * live path, the event's own ULID on a replay, and the Discord override where a
 * message carried one, and its random suffix is gone either way. It does not
 * have to be: `sort_idx_prev` holds the keys as they stood before the clear, so
 * each watermark is resolved through the entity it named rather than guessed
 * from its contents.
 *
 * Runs after the replay, when `entities` carries the new keys. A watermark that
 * matches no snapshot row — the `''`/`'0'` a lazily-created position starts
 * with, or a message since deleted — is left alone and counted rather than
 * guessed at.
 */
async function reanchorReadStateWatermarks(
  spaceDb: DbLike,
  readState: DbLike,
  streamDid: StreamDid,
): Promise<{ moved: number; unresolved: number }> {
  const rows = await readState
    .query(
      `select user_did, room_id, seen_up_to from read_positions where space_did = ?`,
    )
    .all<{ user_did: string; room_id: string; seen_up_to: string }>(streamDid);
  if (rows.length === 0) return { moved: 0, unresolved: 0 };

  const updates: Array<{ type: "run"; sql: string; params: unknown[] }> = [];
  let unresolved = 0;
  for (const row of rows) {
    const next = await spaceDb
      .query(
        `select e.sort_idx as sort_idx
           from sort_idx_prev p
           join entities e on e.id = p.id
          where p.sort_idx = ?`,
      )
      .get<{ sort_idx: string | null }>(row.seen_up_to);
    if (next?.sort_idx == null) {
      if (row.seen_up_to !== "" && row.seen_up_to !== "0") unresolved++;
      continue;
    }
    updates.push({
      type: "run",
      sql: "update read_positions set seen_up_to = ? where user_did = ? and room_id = ?",
      params: [next.sort_idx, row.user_did, row.room_id],
    });
  }

  if (updates.length > 0) await readState.transaction(updates);
  return { moved: updates.length, unresolved };
}

/**
 * Recompute `entities.sort_idx` for every message in the space from the log,
 * using the same key rule the live materialiser and a rebuild use.
 *
 * The old keys encode the sender's ULID time (and, for same-millisecond
 * bursts, a random suffix), so they are discarded rather than adjusted: the
 * task clears the column and replays the ordering events in log order. A
 * cleared column is a state the read path already handles — it falls back to
 * the row id — so a crash mid-task leaves the space readable and the retry
 * starts from the clear again.
 *
 * Every ordering event this replays is a pure write, which is what allows the
 * whole migration to run as batched transactions instead of one worker
 * round-trip per event. A reorder is the exception: it derives its key from the
 * neighbours' keys as they stand at that point in the log, so an in-place
 * replay over a DB that already holds every row can land the message somewhere
 * a from-empty rebuild would not. Reorders have no producer today, so rather
 * than approximate them the task declines and lets the caller rebuild.
 */
async function recomputeSortIdxFromLog(
  db: DbLike,
  streamDid: StreamDid,
): Promise<void> {
  const spaceDb = db.forSpace?.(streamDid);
  if (!spaceDb) {
    throw new Error(
      `recomputeSortIdxFromLog: no per-space handle for ${streamDid}`,
    );
  }

  if (await findReorderEvent(db, streamDid)) {
    throw new SpaceMigrationNeedsRebuildError(
      `${streamDid} has a reorderMessage event, whose key depends on neighbouring rows in a way an in-place replay cannot reproduce`,
    );
  }

  // Snapshot the keys this migration is about to destroy. They are not
  // recomputable — the live path keyed a message by this server's arrival
  // clock and the replay path by the event's own ULID, and either way the
  // random suffix is gone — so the read-state watermarks that stored one can
  // only be followed through the entity it named. Created before the clear,
  // and only when absent, so a retry after an interrupted pass still holds the
  // pre-clear keys rather than a table of nulls. Dropped once the re-anchor has
  // consumed it.
  await spaceDb.run(
    "create table if not exists sort_idx_prev as select id, sort_idx from entities",
  );
  await spaceDb.run("update entities set sort_idx = null");

  let cursor = -1;
  let applied = 0;
  let steps: Array<{ type: "run"; sql: string; params: unknown[] }> = [];

  const flush = async (): Promise<void> => {
    if (steps.length === 0) return;
    await spaceDb.transaction(steps);
    steps = [];
  };

  for (;;) {
    const rows = await db
      .query(
        `select idx, user, payload, received_at, created_at from stream_events
          where stream_id = ? and idx > ?
          order by idx limit ?`,
      )
      .all<RawEvent>(streamDid, cursor, SCAN_CHUNK);
    if (rows.length === 0) break;

    for (const row of rows) {
      const event = decode(row.payload) as Event;
      const idx = row.idx as StreamIndex;
      const receivedAt = row.received_at ?? undefined;
      const createdAt = row.created_at ?? undefined;

      if (event.$type === "space.roomy.message.createMessage.v0") {
        steps.push({
          type: "run",
          sql: "update entities set sort_idx = ? where id = ? and sort_idx is null",
          params: [messageSortIdxKey(event, idx, receivedAt, createdAt), event.id],
        });
      } else if (event.$type === "space.roomy.message.forwardMessages.v0") {
        steps.push({
          type: "run",
          sql: "update entities set sort_idx = ? where id = ? and sort_idx is null",
          params: [messageSortIdxKey(event, idx, receivedAt, createdAt), event.id],
        });
      } else if (event.$type === "space.roomy.message.moveMessages.v0") {
        const sortIdx = messageSortIdxKey(event, idx, receivedAt, createdAt);
        for (const messageId of event.messageIds) {
          steps.push({
            type: "run",
            sql: "update entities set sort_idx = ? where id = ? and room = ?",
            params: [sortIdx, messageId, event.toRoomId],
          });
        }
      } else {
        continue;
      }

      applied++;
      if (steps.length >= APPLY_CHUNK) await flush();
    }

    cursor = rows[rows.length - 1]!.idx;
  }

  await flush();

  // The entities now carry their new keys, so the read-state watermarks that
  // stored an old one can be moved onto them. This runs on every re-run, not
  // only the first: the task is idempotent, so an interrupted pass (or a second
  // pass after a deploy that re-runs it) must leave the watermarks correct
  // rather than double-remapped. By then each stored key is either already a
  // new key — which matches no snapshot row — or an old one, and only the
  // latter moves.
  const readState = createReadStateResolver(db)();
  const { moved, unresolved } = readState
    ? await reanchorReadStateWatermarks(spaceDb, readState, streamDid)
    : { moved: 0, unresolved: 0 };
  await spaceDb.run("drop table if exists sort_idx_prev");
  log.info(
    "startup",
    `sort_idx migration replayed ${applied} ordering events for ${streamDid}` +
      (readState
        ? `, re-anchored ${moved} read watermark(s), ${unresolved} left unresolved`
        : ""),
  );
}

/**
 * Async data migrations keyed by the per-space schema version that scheduled
 * them. Structural DDL is applied synchronously by the DB worker.
 *
 * Typed as `Record<SpaceAsyncVersion, …>`, where `SpaceAsyncVersion` is derived
 * from `SPACE_MIGRATIONS`. Adding a `kind: "data"` version to the manifest
 * therefore fails the typecheck until a task is registered here, and
 * registering a task for a `kind: "structural"` version is a type error — the
 * two lists cannot drift into a boot-time crash loop.
 */
const SPACE_MIGRATION_TASKS: Record<SpaceAsyncVersion, SpaceMigrationTask> = {
  "3": recomputeSortIdxFromLog,
};

type SpaceMigrationTask = (
  db: DbLike,
  streamDid: StreamDid,
) => Promise<void>;

/**
 * Run this space's incomplete data migrations in version order, within the
 * write gate.
 *
 * The gate is the same one a blue-green rebuild opens: reads keep serving the
 * space throughout, and a write is rejected with a retryable 409 rather than
 * racing the pass. The first request against the space handle is what makes
 * the worker open the DB and apply the structural `up`s, so it comes before the
 * marker read.
 *
 * Rejects with whatever a task rejects with — including
 * `SpaceMigrationNeedsRebuildError`, which the caller turns into a rebuild.
 */
export async function upgradeSpaceInPlace(
  db: DbLike,
  streamDid: StreamDid,
): Promise<void> {
  const spaceDb = db.forSpace?.(streamDid);
  if (!spaceDb) {
    throw new Error(`upgradeSpaceInPlace: no per-space handle for ${streamDid}`);
  }

  await db.spaceMigrationBegin?.(streamDid);
  try {
    // Forces the worker to open + upgrade the DB, so the version row and the
    // migration markers below describe the current schema.
    await spaceDb.query("select 1 as ok").get();

    // The worker upgrades an older DB in place or, when the on-disk version is
    // not one this build can start from, serves it as-is. A version that did
    // not advance is that second case: there is nothing to migrate, and only a
    // replay brings the space up to date.
    const versionRow = await spaceDb
      .query("select version from space_schema_version where id = 1")
      .get<{ version: string }>();
    if ((versionRow?.version ?? "") !== SPACE_SCHEMA_VERSION) {
      throw new SpaceMigrationNeedsRebuildError(
        `${streamDid} is on schema v${versionRow?.version ?? "unknown"}, which this build cannot upgrade in place`,
      );
    }

    const pending = await spaceDb
      .query(
        `select version from space_schema_migrations
          where completed_at is null
          order by cast(version as integer)`,
      )
      .all<{ version: string }>();

    for (const { version } of pending) {
      const entry = spaceMigrationEntry(version);
      if (!entry) {
        // Unknown version: the manifest is the source of truth, so a marker
        // for a version absent from it means a schema this build does not
        // know. Rebuild rather than migrate against an unknown shape.
        throw new SpaceMigrationNeedsRebuildError(
          `Unknown per-space schema version v${version} (not in SPACE_MIGRATIONS)`,
        );
      }

      log.info("startup", `running space post-migration v${version} for ${streamDid}`);
      if (entry.kind === "data") {
        await SPACE_MIGRATION_TASKS[version as SpaceAsyncVersion](db, streamDid);
      }
      await spaceDb.run(
        `update space_schema_migrations
            set completed_at = ?
          where version = ? and completed_at is null`,
        Date.now(),
        version,
      );
      log.info("startup", `space post-migration v${version} complete for ${streamDid}`);
    }
  } finally {
    await db.spaceMigrationEnd?.(streamDid);
  }
}
