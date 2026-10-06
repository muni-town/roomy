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
        `select idx, user, payload, received_at from stream_events
          where stream_id = ? and idx > ?
          order by idx limit ?`,
      )
      .all<RawEvent>(streamDid, cursor, SCAN_CHUNK);
    if (rows.length === 0) break;

    for (const row of rows) {
      const event = decode(row.payload) as Event;
      const idx = row.idx as StreamIndex;
      const receivedAt = row.received_at ?? undefined;

      if (event.$type === "space.roomy.message.createMessage.v0") {
        steps.push({
          type: "run",
          sql: "update entities set sort_idx = ? where id = ? and sort_idx is null",
          params: [messageSortIdxKey(event, idx, receivedAt), event.id],
        });
      } else if (event.$type === "space.roomy.message.forwardMessages.v0") {
        steps.push({
          type: "run",
          sql: "update entities set sort_idx = ? where id = ? and sort_idx is null",
          params: [messageSortIdxKey(event, idx, receivedAt), event.id],
        });
      } else if (event.$type === "space.roomy.message.moveMessages.v0") {
        const sortIdx = messageSortIdxKey(event, idx, receivedAt);
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
  log.info("startup", `sort_idx migration replayed ${applied} ordering events for ${streamDid}`);
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
