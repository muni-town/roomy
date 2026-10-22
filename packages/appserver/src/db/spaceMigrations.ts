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
import { upsertSpaceHandle } from "../queries/spaceHandles.ts";
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
        // `messageIds` postdates the collection: the schema moved from a
        // singular `messageId`, so the log holds move events that never carried
        // the field. Skipping those instead of reading through them keeps the
        // replay from throwing — which would abandon this migration and send
        // the space down the rebuild path on every boot — and is the same
        // answer the live path gives them: a move that names no messages has no
        // key to derive.
        if (!("messageIds" in event) || !("toRoomId" in event)) continue;
        const ids = event.messageIds;
        const toRoomId = event.toRoomId;
        if (!Array.isArray(ids) || typeof toRoomId !== "string") continue;
        const sortIdx = messageSortIdxKey(event, idx, receivedAt, createdAt);
        for (const messageId of ids) {
          if (typeof messageId !== "string") continue;
          steps.push({
            type: "run",
            sql: "update entities set sort_idx = ? where id = ? and room = ?",
            params: [sortIdx, messageId, toRoomId],
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
  "4": moveSpaceHandleToGlobal,
  "5": moveLinkEmbedsToGlobal,
};

type SpaceMigrationTask = (
  db: DbLike,
  streamDid: StreamDid,
) => Promise<void>;

/**
 * Copy a space's DNS handle out of the per-space `comp_space.handle` into the
 * global `space_handles` store, when the column is still present and carries a
 * value.
 *
 * The handle is assigned by the space's PDS/DNS and never written by an event,
 * so it is not a projection of the log: a space replayed from the log had no
 * way to reproduce it. It now lives in the global DB, beside the global
 * `profiles` table, and the per-space DB keeps no copy.
 *
 * Called from the v4 migration (which then drops the column) and from the boot
 * sweep's fallback to a blue-green rebuild, whose fresh DB has no such column
 * and would otherwise discard the value with the old file. Idempotent, and a
 * no-op once the column is gone.
 */
export async function carrySpaceHandleToGlobal(
  db: DbLike,
  streamDid: StreamDid,
): Promise<void> {
  const spaceDb = db.forSpace?.(streamDid);
  if (!spaceDb) return;

  const columns = await spaceDb
    .query("select name from pragma_table_info('comp_space')")
    .all<{ name: string }>();
  if (!columns.some((c) => c.name === "handle")) return;

  const row = await spaceDb
    .query("select handle from comp_space where entity = ?")
    .get<{ handle: string | null }>(streamDid);
  if (!row?.handle) return;

  const globalDb = db.global?.();
  // A `null` global handle means an adapter that does not route the global DB
  // (a sync test adapter). There is nothing to migrate onto there.
  if (globalDb) await upsertSpaceHandle(streamDid, row.handle, globalDb);
}

/**
 * v4: move the DNS handle to the global store and drop the per-space column.
 *
 * The copy must happen before the DDL removes the column, and the worker
 * applies structural `up`s at open — ahead of this task — so the removal is
 * here rather than in the version's `up`.
 */
async function moveSpaceHandleToGlobal(
  db: DbLike,
  streamDid: StreamDid,
): Promise<void> {
  await carrySpaceHandleToGlobal(db, streamDid);
  const spaceDb = db.forSpace?.(streamDid);
  if (!spaceDb) {
    throw new Error(
      `moveSpaceHandleToGlobal: no per-space handle for ${streamDid}`,
    );
  }

  const columns = await spaceDb
    .query("select name from pragma_table_info('comp_space')")
    .all<{ name: string }>();
  if (!columns.some((c) => c.name === "handle")) return;

  await spaceDb.run("alter table comp_space drop column handle");
  log.info("startup", `moved the DNS handle of ${streamDid} into the global store`);
}

/**
 * Copy a space's enriched link rows out of the per-space
 * `comp_embed_link_data` into the global `link_embeds` store.
 *
 * The value is fetched from an external service, not derived from the log, so
 * it could not be reproduced by a replay and did not belong in a per-space
 * projection. It is now keyed by URL in the global DB, where the sweeper
 * already works, and read paths resolve it from there.
 *
 * Called from the v5 migration (which then drops the table) and from the boot
 * sweep's fallback to a blue-green rebuild, whose fresh DB has no such table
 * and would otherwise discard the rows with the old file. Idempotent: the
 * store UPSERTs on the URL, so a re-run rewrites the same rows.
 *
 * `insert or ignore` on the store's behalf is deliberately NOT used — a row
 * carried across must not overwrite one the sweeper has since re-fetched and
 * settled, but the migration runs before any sweep of this build, and a
 * re-fetch that lands first carries strictly fresher state. Last writer wins is
 * the same rule the store already applies to two sweeps racing the same URL.
 */
export async function carryLinkEmbedsToGlobal(
  db: DbLike,
  streamDid: StreamDid,
): Promise<void> {
  const spaceDb = db.forSpace?.(streamDid);
  if (!spaceDb) return;
  const globalDb = db.global?.();
  if (!globalDb) return;

  // The source may already be on the current schema — a fresh DB is created
  // from a `schema-space.sql` that no longer declares the table — in which case
  // there is nothing to carry and the copy is a no-op rather than an error.
  const tables = await spaceDb
    .query(
      "select name from sqlite_master where type = 'table' and name = 'comp_embed_link_data'",
    )
    .all<{ name: string }>();
  if (tables.length === 0) return;

  const rows = await spaceDb
    .query(
      `select entity, embed_json, attempts, retry_after, fetched_at, created_at, updated_at
         from comp_embed_link_data`,
    )
    .all<{
      entity: string;
      embed_json: string | null;
      attempts: number;
      retry_after: number | null;
      fetched_at: number;
      created_at: number;
      updated_at: number;
    }>();
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += APPLY_CHUNK) {
    await globalDb.transaction(
      rows.slice(i, i + APPLY_CHUNK).map((r) => ({
        type: "run" as const,
        sql: `insert into link_embeds
                (url, embed_json, attempts, retry_after, fetched_at, created_at, updated_at)
              values (?, ?, ?, ?, ?, ?, ?)
              on conflict(url) do update set
                embed_json = excluded.embed_json,
                attempts = excluded.attempts,
                retry_after = excluded.retry_after,
                fetched_at = excluded.fetched_at,
                updated_at = excluded.updated_at`,
        params: [
          r.entity,
          r.embed_json,
          r.attempts,
          r.retry_after,
          r.fetched_at,
          r.created_at,
          r.updated_at,
        ],
      })),
    );
  }
  log.info(
    "startup",
    `moved ${rows.length} enriched link row(s) of ${streamDid} into the global store`,
  );
}

/**
 * v5: move the enriched link metadata to the global store and drop the
 * per-space table.
 *
 * The copy must happen before the DDL removes the rows, and the worker applies
 * structural `up`s at open — ahead of this task — so the removal is here rather
 * than in the version's `up`.
 */
async function moveLinkEmbedsToGlobal(
  db: DbLike,
  streamDid: StreamDid,
): Promise<void> {
  await carryLinkEmbedsToGlobal(db, streamDid);
  const spaceDb = db.forSpace?.(streamDid);
  if (!spaceDb) {
    throw new Error(`moveLinkEmbedsToGlobal: no per-space handle for ${streamDid}`);
  }

  const tables = await spaceDb
    .query(
      "select name from sqlite_master where type = 'table' and name = 'comp_embed_link_data'",
    )
    .all<{ name: string }>();
  if (tables.length === 0) return;

  await spaceDb.run("drop table comp_embed_link_data");
  log.info("startup", `dropped the per-space embed link table of ${streamDid}`);
}

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
