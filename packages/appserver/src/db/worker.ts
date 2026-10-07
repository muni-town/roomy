/**
 * SQLite worker — runs in a Bun.Worker thread.
 *
 * Owns the read-state DB (`readStateDb`), the event-log DB (`eventsDb`),
 * the per-space DBs (`data/spaces/<spaceDid>.sqlite`), and the global DB
 * (`data/global.sqlite`). The per-space DBs are the source of truth for space
 * data.
 *
 * Per-space DBs (`data/spaces/<spaceDid>.sqlite`) are opened lazily on first
 * request for that space, cached with LRU eviction, and created by
 * re-materialising that stream from the event log (never backfilled from
 * another DB). The global DB (`data/global.sqlite`) is opened lazily on
 * first request and holds `joinedSpace`/`leftSpace` edges, the global
 * `profiles` table, and the `entity_space` entity→space index.
 *
 * All handlers are synchronous (bun:sqlite is synchronous in the worker
 * thread). Errors are caught and returned as structured { error, errorCode }
 * in the response.
 */

import { Database, type Changes } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerRequest, WorkerResponse } from "./types.ts";
import {
  READSTATE_MIGRATIONS,
  readStateMigrationEntry,
} from "./readStateVersions.ts";
import {
  GLOBAL_MIGRATIONS,
  globalMigrationEntry,
} from "./globalVersions.ts";
import { SPACE_MIGRATIONS, spaceMigrationEntry } from "./spaceVersions.ts";
import { dbPath, spacesDir as resolveSpacesDir } from "./paths.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Cast unknown[] to SQLQueryBindings[] for bun:sqlite. */
function toBindings(params?: unknown[]): SQLQueryBindings[] {
  return (params ?? []) as SQLQueryBindings[];
}

/** Normalise lastInsertRowid (number | bigint) to number | undefined. */
function normaliseRowid(
  rowid: number | bigint | undefined,
): number | undefined {
  if (rowid === undefined || rowid === null) return undefined;
  return Number(rowid);
}

// ─── State ────────────────────────────────────────────────────────────────

let readStateDb: Database | null = null;
let eventsDb: Database | null = null;
const preparedStmts = new Map<number, ReturnType<Database["prepare"]>>();
let nextHandle = 1;
let closed = false;

/** Per-space DBs, opened lazily and LRU-evicted. Keyed by spaceDid. */
const spaceDbs = new Map<string, { db: Database; lastUsed: number }>();
/**
 * Spaces with their in-place migration gate open (`spaceMigrationBegin`).
 * A space in this set is mid-upgrade: the write gate in `StreamManager`
 * rejects writes to it, and reads keep serving the DB being upgraded.
 * Distinct from `spaceRebuilds`, which swaps a whole new file in.
 */
const spaceMigrating = new Set<string>();
/**
 * Blue-green rebuild state, keyed by spaceDid. While a rebuild is in flight the
 * canonical (old-schema) DB keeps serving reads and a fresh DB is materialised
 * beside it. The entry pins both handles so LRU cannot evict either mid-rebuild.
 */
const spaceRebuilds = new Map<
  string,
  { rebuild: Database; canonical: Database }
>();
/** Global DB (joinedSpace/leftSpace edges + profiles + entity index), opened lazily. */
let globalDb: Database | null = null;
let spacesDir: string | null = null;
let globalDbPath: string | null = null;
let spaceSchemaVersion: string | null = null;
let globalSchemaVersion: string | null = null;
/** Max concurrently-open space DBs before LRU eviction. */
let maxSpaceDbs = 100;
/**
 * Worker role. "space" workers only open per-space DBs; "global", "readstate"
 * and "events" workers each own exactly one of the shared DBs; "system" is the
 * legacy combined role that owns the global/read-state/event-log DBs on one
 * thread (used by isolated pools and kept for backward compat). Defaults to
 * "system" for the single-worker path.
 */
let role:
  | "space"
  | "system"
  | "global"
  | "readstate"
  | "events" = "system";

/**
 * Service-time reporting for the worker's own request loop.
 *
 * `roomy_db_wait_seconds` is observed on the MAIN thread when a worker replies,
 * so a request that waited behind another collapses into one bucket with no way
 * to tell WHICH request held the thread. The loop below times each request
 * inside the worker and reports the offenders on its worker messages, which is
 * the only channel that reaches the app's log sink: a worker thread has no
 * access to it (`ALLOY_URL` is read by the main thread's sink, and stdout from
 * a worker is not collected in production), so a slow request that stays silent
 * inside the worker is invisible no matter how long it runs.
 *
 * Worker `onmessage` handlers are serialized, so a queued request's timer
 * starts only once the request ahead of it has finished — its wait lives in the
 * message queue and is not visible here. That is the point: the main thread
 * already measures the victims' wait, and this measures the offender's service
 * time. A handler blocked inside SQLite on a busy lock still counts, because
 * the call does not return until the lock frees.
 */
const SLOW_REQUEST_MS = 50;

// ─── Schema paths ─────────────────────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SPACE_SCHEMA_PATH = join(THIS_DIR, "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(THIS_DIR, "schema-global.sql");
const READSTATE_SCHEMA_PATH = join(THIS_DIR, "readStateSchema.sql");
const EVENTS_SCHEMA_PATH = join(THIS_DIR, "eventsSchema.sql");

// ─── Schema helpers ───────────────────────────────────────────────────────

class SchemaVersionMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Schema version mismatch: expected ${expected}, got ${actual}`,
    );
    this.name = "SchemaVersionMismatchError";
  }
}

/**
 * The global version list lives in globalVersions.ts (shared with the
 * main-thread migration runner, which types its task map against it). Sorted
 * numerically so upgrade order never depends on object-key ordering rules.
 */
const GLOBAL_VERSION_KEYS = Object.keys(GLOBAL_MIGRATIONS).sort(
  (a, b) => Number(a) - Number(b),
);

/**
 * Schedule the async data migration for a single global version (if it has
 * one). The boot runner executes the registered task and stamps completion;
 * structural versions are not scheduled — the schema exec created their tables.
 */
function scheduleGlobalMigration(db: Database, version: string): void {
  if (globalMigrationEntry(version)?.kind === "data") {
    db.query(
      "insert or ignore into global_schema_migrations (version, completed_at) values (?, null)",
    ).run(version);
  }
}

/**
 * Apply every version in `(fromExclusive, toInclusive]` in order: its
 * structural `up` (if any), then its async data marker (if it is a data
 * version). Traversing the whole range means a DB that jumps several versions
 * in one deploy still runs every skipped data migration, instead of only the
 * newest one.
 */
function applyGlobalUpgrades(
  db: Database,
  fromExclusive: number,
  toInclusive: number,
): void {
  for (const version of GLOBAL_VERSION_KEYS) {
    const num = parseInt(version, 10);
    if (num <= fromExclusive || num > toInclusive) continue;
    globalMigrationEntry(version)?.up?.(db);
    scheduleGlobalMigration(db, version);
  }
}

/**
 * Global DB upgrades are additive. Apply the idempotent current schema and
 * advance an older numeric version in place so cross-space derived state
 * (especially membership edges) is never discarded by a table addition.
 */
function initializeGlobalSchema(db: Database, expectedVersion: string): void {
  let row: { version: string } | null;
  try {
    row = db
      .query<{ version: string }, []>(
        "select version from global_schema_version where id = 1",
      )
      .get();
  } catch {
    row = null;
  }

  const schema = readFileSync(GLOBAL_SCHEMA_PATH, "utf-8");
  if (!row) {
    // Fresh DB: the schema file already creates every table, so only the
    // current version's own task (if it has one) needs scheduling.
    db.exec(schema);
    db.exec(
      `insert into global_schema_version (id, version) values (1, '${expectedVersion}')`,
    );
    scheduleGlobalMigration(db, expectedVersion);
    return;
  }

  if (row.version === expectedVersion) {
    // Current version: re-apply the schema (heals a table added in this
    // version) and ensure this version's task marker exists.
    db.exec(schema);
    scheduleGlobalMigration(db, expectedVersion);
    return;
  }

  const actual = Number.parseInt(row.version, 10);
  const expected = Number.parseInt(expectedVersion, 10);
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || actual >= expected) {
    throw new SchemaVersionMismatchError(expectedVersion, row.version);
  }

  db.transaction(() => {
    db.exec(schema);
    applyGlobalUpgrades(db, actual, expected);
    db.query("update global_schema_version set version = ? where id = 1").run(expectedVersion);
  })();
}

// The read-state version list lives in readStateVersions.ts (shared with the
// main-thread migration runner, which types its task map against it). Sorted
// numerically so upgrade order never depends on object-key ordering rules.
const READSTATE_VERSION_KEYS = Object.keys(READSTATE_MIGRATIONS).sort(
  (a, b) => Number(a) - Number(b),
);

function initializeReadStateSchema(
  db: Database,
  schemaPath: string,
  expectedVersion: string,
): void {
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  const row = db
    .query<{ version: string }, []>(
      "select version from readstate_schema_version where id = 1",
    )
    .get();
  if (!row) {
    // Fresh DB: the schema file creates user_thread_activity WITH space_did,
    // but the per-space index is intentionally not in the schema file (see
    // readStateSchema.sql) so it can't throw on pre-v7 DBs. Create it here for
    // fresh DBs; the v7 migration creates it for existing DBs.
    db.exec(`
      create index if not exists idx_user_thread_activity_user_space
        on user_thread_activity(user_did, space_did, last_active_at desc)
    `);
    db.exec(
      `insert into readstate_schema_version (id, version) values (1, '${expectedVersion}')`,
    );
    return;
  }

  const currentVersion = parseInt(row.version, 10);
  const expectedNum = parseInt(expectedVersion, 10);
  if (currentVersion < expectedNum) {
    const upsertVersion = db.prepare(
      "update readstate_schema_version set version = ? where id = 1",
    );
    // `Object.keys` on a numeric-key object yields ascending integer order, so
    // the manifest is already the ordered migration list.
    for (const version of READSTATE_VERSION_KEYS) {
      const num = parseInt(version, 10);
      if (num <= currentVersion || num > expectedNum) continue;
      const entry = readStateMigrationEntry(version);
      db.transaction(() => {
        // Structural DDL for this version (if any). The schema exec above has
        // already created every `create table if not exists` in the schema
        // file, so only genuine ALTERs carry an `up`.
        entry?.up?.(db);
        // Data versions schedule an async task for the boot runner; structural
        // versions have no async work and simply advance the version row.
        if (entry?.kind === "data") {
          db.query(
            "insert or ignore into readstate_schema_migrations (version, completed_at) values (?, null)",
          ).run(version);
        }
        upsertVersion.run(version);
      })();
    }
  }
}

// The per-space version list lives in spaceVersions.ts (shared with the
// main-thread migration runner, which types its task map against it).
const SPACE_VERSION_KEYS = Object.keys(SPACE_MIGRATIONS).sort(
  (a, b) => Number(a) - Number(b),
);

/**
 * The on-disk version is read FIRST and the schema DDL is only exec'd when the
 * DB is fresh, current, or genuinely upgradable — never on an un-upgradable
 * one, which must be left byte-for-byte untouched for the rebuild to keep
 * serving it.
 *
 * An older numeric version takes every version in `(actual, expected]` in
 * order — its structural `up`, then a null marker for its data task — inside one
 * transaction that also advances the version row, so a crash leaves the DB on
 * the old version with the migration still owed. A version the manifest does
 * not know (higher than this build, unparseable, or below the manifest's first
 * version) is a `SchemaVersionMismatchError`: the caller serves the old DB as-is
 * and the boot runner rebuilds it from the log.
 */
function initializeSpaceSchema(db: Database, expectedVersion: string): void {
  let row: { version: string } | null;
  try {
    row = db
      .query<{ version: string }, []>(
        "select version from space_schema_version where id = 1",
      )
      .get();
  } catch {
    // No version table yet — a fresh DB. Fall through to apply the schema.
    row = null;
  }

  if (!row) {
    // Fresh DB: the schema file already creates every table, and a space with
    // no DB has no materialised state to migrate. Nothing is owed.
    db.exec(readFileSync(SPACE_SCHEMA_PATH, "utf-8"));
    db.exec(
      `insert into space_schema_version (id, version) values (1, '${expectedVersion}')`,
    );
    return;
  }

  if (row.version === expectedVersion) {
    // Current version: re-apply the schema (idempotent) so a DB stamped as
    // current but missing a table added in the same version heals. A DB that
    // reached this version already has its migrations, so none is scheduled.
    db.exec(readFileSync(SPACE_SCHEMA_PATH, "utf-8"));
    return;
  }

  const actual = Number.parseInt(row.version, 10);
  const expected = Number.parseInt(expectedVersion, 10);
  const minimum = Number.parseInt(SPACE_VERSION_KEYS[0] ?? "", 10);
  if (
    !Number.isFinite(actual) ||
    !Number.isFinite(expected) ||
    actual >= expected ||
    actual < minimum
  ) {
    throw new SchemaVersionMismatchError(expectedVersion, row.version);
  }

  db.transaction(() => {
    db.exec(readFileSync(SPACE_SCHEMA_PATH, "utf-8"));
    for (const version of SPACE_VERSION_KEYS) {
      const num = parseInt(version, 10);
      if (num <= actual || num > expected) continue;
      spaceMigrationEntry(version)?.up?.(db);
      scheduleSpaceDataMigration(db, version);
    }
    db.query("update space_schema_version set version = ? where id = 1").run(
      expectedVersion,
    );
  })();
}

/** Mark `version`'s async task as owed by this space (no-op for structural). */
function scheduleSpaceDataMigration(db: Database, version: string): void {
  if (spaceMigrationEntry(version)?.kind === "data") {
    db.query(
      "insert or ignore into space_schema_migrations (version, completed_at) values (?, null)",
    ).run(version);
  }
}

// ─── Per-space DB management ──────────────────────────────────────────────

/**
 * Open (or return from the LRU cache) the per-space DB for `spaceDid`.
 * On first open: create the file, apply the per-space schema, upgrade an
 * older DB to the current version in place, and refresh the query-planner
 * statistics. The DB is populated by re-materialising the stream from the
 * event log.
 */
function openSpaceDb(spaceDid: string): Database {
  if (!spacesDir) throw new Error("Per-space DBs not initialized (no init)");
  const cached = spaceDbs.get(spaceDid);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.db;
  }

  let db = openSpaceDbFile(spaceDid);
  try {
    initializeSpaceSchema(db, spaceSchemaVersion ?? "");
  } catch (err) {
    if (err instanceof SchemaVersionMismatchError) {
      // The on-disk version is not one this build can upgrade from (unknown,
      // higher, or below the manifest's first version). Do NOT wipe it — serve
      // the OLD DB as-is so reads keep returning the existing data until an
      // explicit rebuild (spaceRebuildBegin → replay → commit) swaps it. The
      // rebuild is driven by reMaterializeFromLocalEvents, never by a read. The
      // file is left untouched.
    } else {
      // The space DB must never be left half-initialised: a partial file
      // (schema applied but init failed, or worse) reads back as
      // "database disk image is malformed" on every subsequent open.
      // Close and delete it so the next open retries from scratch.
      deleteSpaceDbFile(spaceDid, db);
      throw err;
    }
  }

  // Refresh the query-planner statistics on the open that populates this
  // handle: statistics live in the file, so a space the boot sweep already
  // covered pays the ~0.06ms `PRAGMA optimize` no-op check, while a space that
  // is new, or was first opened after the sweep passed it, gets its statistics
  // before it serves a query.
  analyzeSpaceDb(db);

  // LRU eviction: close the least-recently-used handle when over capacity.
  // Statistics are refreshed immediately before the close, which is the
  // cadence SQLite documents for `PRAGMA optimize` (periodically, and before
  // closing a long-lived connection): the handle being evicted is the one that
  // has been serving writes, so this is where a space's growth gets measured.
  if (spaceDbs.size >= maxSpaceDbs) {
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [did, entry] of spaceDbs) {
      if (entry.lastUsed < oldestTs) {
        oldestTs = entry.lastUsed;
        oldest = did;
      }
    }
    if (oldest !== null && oldest !== spaceDid) {
      const entry = spaceDbs.get(oldest);
      spaceDbs.delete(oldest);
      try {
        if (entry) analyzeSpaceDb(entry.db);
        entry?.db.close();
      } catch {
        /* best-effort */
      }
    }
  }

  spaceDbs.set(spaceDid, { db, lastUsed: Date.now() });
  return db;
}

/** Close and delete a per-space DB file (best-effort). */
function deleteSpaceDbFile(spaceDid: string, db: Database): void {
  try {
    db.close();
  } catch {
    /* best-effort */
  }
  if (spacesDir !== ":memory:" && spacesDir !== null) {
    const path = join(spacesDir, `${spaceDid}.sqlite`);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(path + suffix);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Apply the standard pragmas shared by every per-space SQLite connection. */
function applySpacePragmas(db: Database): void {
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  db.exec("pragma busy_timeout = 5000");
}

/**
 * Refresh a per-space DB's query-planner statistics (`sqlite_stat1`).
 *
 * Without statistics SQLite costs indexes by fixed defaults, and for an
 * equality lookup it prices the single-column index it happens to walk
 * (`idx_entities_stream_room`) below the table's rowid index. Measured on a
 * 131k-entity space DB, every `id in (…) and stream_id = ?` lookup — the shape
 * `readPositions`/`userActiveThreads` issue on each room read — scans the
 * space's whole `stream_id` partition: 8 ids cost 323 ms unanalyzed against
 * 0.006 ms analyzed, and the mis-plan starts at ~500 entities.
 *
 * `PRAGMA optimize` rather than a bare `ANALYZE`: it re-analyzes only what its
 * heuristics call stale, so a DB whose statistics are current pays ~0.01ms,
 * while the tables that actually grew get re-measured. Statistics persist in
 * the file, so this is a no-op after the first open of each DB.
 *
 * Best-effort: statistics are an optimization, so a failure leaves the
 * previous plan in place rather than failing the open. The worker has no log
 * sink, so the failure is silent here — the boot sweep's explicit `analyze`
 * reports it.
 */
function analyzeSpaceDb(db: Database): void {
  try {
    db.exec("pragma optimize");
  } catch {
    /* keep serving with the existing plan */
  }
}

function openSpaceDbFile(spaceDid: string): Database {
  if (spacesDir === ":memory:") {
    // In-memory per-space DBs (tests): each connection is its own fresh
    // DB, cached per spaceDid in the worker LRU. Recreated on every worker
    // restart, so tests never leak files or cross-test state.
    const db = new Database(":memory:");
    applySpacePragmas(db);
    return db;
  }
  const path = join(spacesDir!, `${spaceDid}.sqlite`);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  applySpacePragmas(db);
  return db;
}

// ─── Blue-green rebuild (worker seam) ─────────────────────────────────────

/**
 * Open (or return) the temp rebuild DB for `spaceDid` at
 * `data/spaces/<spaceDid>.sqlite.new`, creating it with the CURRENT schema on
 * first use and marking the space as rebuilding. The canonical (old-schema)
 * DB keeps serving reads throughout. Idempotent per space.
 */
function openSpaceDbRebuild(spaceDid: string): Database {
  if (!spacesDir) throw new Error("Per-space DBs not initialized (no init)");
  const existing = spaceRebuilds.get(spaceDid);
  if (existing) return existing.rebuild;

  let rebuild: Database;
  if (spacesDir === ":memory:") {
    rebuild = new Database(":memory:");
    applySpacePragmas(rebuild);
  } else {
    const tmpPath = join(spacesDir, `${spaceDid}.sqlite.new`);
    mkdirSync(dirname(tmpPath), { recursive: true });
    rebuild = new Database(tmpPath, { create: true });
    applySpacePragmas(rebuild);
  }
  // Fresh new-schema DB (no version row → initializeSpaceSchema applies the
  // current schema and stamps the version).
  initializeSpaceSchema(rebuild, spaceSchemaVersion ?? "");

  // Pin the canonical handle too so LRU can't evict it mid-rebuild.
  const canonical = openSpaceDb(spaceDid);
  spaceRebuilds.set(spaceDid, { rebuild, canonical });
  return rebuild;
}

/** Start a rebuild for `spaceDid` (idempotent). */
function handleSpaceRebuildBegin(spaceDid: string): { ok: boolean } {
  openSpaceDbRebuild(spaceDid);
  return { ok: true };
}

/**
 * Atomically swap the rebuild DB over the canonical file and flip routing.
 * Idempotent: returns `{ committed: false }` when nothing is rebuilding.
 */
function handleSpaceRebuildCommit(spaceDid: string): { committed: boolean } {
  const rb = spaceRebuilds.get(spaceDid);
  if (!rb) return { committed: false };

  if (spacesDir === ":memory:") {
    // No files to rename — swap the cached canonical in-memory handle.
    const cached = spaceDbs.get(spaceDid);
    if (cached) {
      try {
        cached.db.close();
      } catch {
        /* best-effort */
      }
    }
    spaceDbs.set(spaceDid, { db: rb.rebuild, lastUsed: Date.now() });
    spaceRebuilds.delete(spaceDid);
    return { committed: true };
  }

  const canonicalPath = join(spacesDir!, `${spaceDid}.sqlite`);
  const tmpPath = `${canonicalPath}.new`;

  // Close the old canonical handle first so it checkpoints + drops its WAL
  // before we overwrite the file (else it could re-create a stale -wal).
  const cached = spaceDbs.get(spaceDid);
  if (cached) {
    try {
      cached.db.close();
    } catch {
      /* best-effort */
    }
    spaceDbs.delete(spaceDid);
  }
  // Checkpoint the rebuild's WAL into the temp file, then atomically rename
  // it over the canonical file (same filesystem ⇒ atomic rename).
  rb.rebuild.close();
  renameSync(tmpPath, canonicalPath);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(canonicalPath + suffix);
    } catch {
      /* already gone */
    }
  }
  // Reopen the canonical file fresh (now new schema) and re-cache it.
  const fresh = new Database(canonicalPath, { create: true });
  applySpacePragmas(fresh);
  spaceDbs.set(spaceDid, { db: fresh, lastUsed: Date.now() });
  spaceRebuilds.delete(spaceDid);
  return { committed: true };
}

/**
 * Abandon a rebuild: delete the temp file and clear the rebuilding flag; the
 * canonical DB keeps serving. Returns `{ aborted: false }` when not rebuilding.
 */
function handleSpaceRebuildAbort(spaceDid: string): { aborted: boolean } {
  const rb = spaceRebuilds.get(spaceDid);
  if (!rb) return { aborted: false };
  try {
    rb.rebuild.close();
  } catch {
    /* best-effort */
  }
  if (spacesDir !== ":memory:" && spacesDir !== null) {
    const tmpPath = join(spacesDir!, `${spaceDid}.sqlite.new`);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(tmpPath + suffix);
      } catch {
        /* already gone */
      }
    }
  }
  spaceRebuilds.delete(spaceDid);
  return { aborted: true };
}

/**
 * Open the in-place migration gate for `spaceDid`: flag the space as
 * migrating (the write gate rejects writes to it) and open the DB, which is
 * what applies the structural version upgrades. Idempotent.
 */
function handleSpaceMigrationBegin(spaceDid: string): { ok: boolean } {
  spaceMigrating.add(spaceDid);
  try {
    openSpaceDb(spaceDid);
  } catch (err) {
    // The gate must not outlive a failed open, or the space would reject
    // writes forever with no migration in flight.
    spaceMigrating.delete(spaceDid);
    throw err;
  }
  return { ok: true };
}

/** Close the migration gate for `spaceDid`. No-op when none is open. */
function handleSpaceMigrationEnd(spaceDid: string): { ended: boolean } {
  return { ended: spaceMigrating.delete(spaceDid) };
}

/** Whether `spaceDid` has its in-place migration gate open. */
function handleIsSpaceMigrating(spaceDid: string): boolean {
  return spaceMigrating.has(spaceDid);
}

/** Whether `spaceDid` is currently rebuilding. */
function handleIsSpaceRebuilding(spaceDid: string): boolean {
  return spaceRebuilds.has(spaceDid);
}

/**
 * Whether the canonical per-space DB for `spaceDid` is on the current schema
 * version. A missing file (fresh space) counts as current. Read-only.
 */
function handleCheckSpaceSchema(spaceDid: string): { current: boolean } {
  if (spacesDir === ":memory:") return { current: true };
  const path = join(spacesDir!, `${spaceDid}.sqlite`);
  if (!existsSync(path)) return { current: true };
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const row = db
      .query<{ version: string }, []>(
        "select version from space_schema_version where id = 1",
      )
      .get();
    return { current: (row?.version ?? "") === (spaceSchemaVersion ?? "") };
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
  }
}


/** Open (or return) the global DB. Created lazily on first request. */
function openGlobalDbInternal(): Database {
  if (globalDb) return globalDb;
  if (!globalDbPath) throw new Error("Global DB not initialized (no init)");
  if (globalDbPath === ":memory:") {
    // In-memory global DB (tests): fresh per worker, no files touched.
    globalDb = new Database(":memory:");
  } else {
    mkdirSync(dirname(globalDbPath), { recursive: true });
    globalDb = new Database(globalDbPath, { create: true });
  }
  globalDb.exec("pragma journal_mode = wal");
  globalDb.exec("pragma synchronous = normal");
  globalDb.exec("pragma foreign_keys = on");
  globalDb.exec("pragma busy_timeout = 5000");
  initializeGlobalSchema(globalDb, globalSchemaVersion ?? "");

  return globalDb;
}


/** Select the DB handle a request targets. */
function dbForRequest(req: WorkerRequest): Database {
  if (req.targetDb === "space") {
    if (!req.spaceDid) throw new Error("spaceDid required for space target");
    // Blue-green route: a "rebuild" target is the temp new-schema DB being
    // materialised; the default "canonical" target is the read-serving DB
    // (which never wipes on schema mismatch). Space DBs are opened only on
    // workers whose init set `spacesDir` (space / global / system); the
    // readstate and events workers leave it unset and throw here.
    if (req.route === "rebuild") return openSpaceDbRebuild(req.spaceDid);
    return openSpaceDb(req.spaceDid);
  }
  if (role === "space") {
    throw new Error(
      `targetDb "${req.targetDb}" not available on a space worker`,
    );
  }
  if (req.targetDb === "global") {
    if (role !== "global" && role !== "system") {
      throw new Error(
        `targetDb "global" not available on a ${role} worker`,
      );
    }
    return openGlobalDbInternal();
  }
  if (req.targetDb === "readstate") {
    if (role !== "readstate" && role !== "system") {
      throw new Error(
        `targetDb "readstate" not available on a ${role} worker`,
      );
    }
    if (!readStateDb) throw new Error("Read-state DB not initialized (no init)");
    return readStateDb;
  }
  if (role !== "events" && role !== "system") {
    throw new Error(
      `targetDb "events" not available on a ${role} worker`,
    );
  }
  if (!eventsDb) throw new Error("Events DB not initialized (no init)");
  return eventsDb;
}

// ─── Message handler ──────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent) => {
  const req = event.data as WorkerRequest;
  // Time inside this handler — the worker thread executing SQL. The main
  // thread separately measures how long the caller waited, which is this plus
  // any time spent queued behind an earlier request.
  const start = performance.now();
  let response: WorkerResponse;
  if (closed) {
    response = { id: req.id, error: "Worker is closed", errorCode: "WORKER_CLOSED" };
  } else {
    try {
      response = { id: req.id, result: handleRequest(req) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorCode =
        err instanceof SchemaVersionMismatchError
          ? "SCHEMA_MISMATCH"
          : "INTERNAL_ERROR";
      response = { id: req.id, error: message, errorCode };
    }
  }
  const selfMs = performance.now() - start;
  // Carried on the response rather than logged here: only the main thread's
  // sink reaches Loki (see SLOW_REQUEST_MS). Rounded to keep the message
  // small; the threshold sits far above a healthy sub-millisecond
  // round-trip, so this only ever carries a stall.
  if (selfMs >= SLOW_REQUEST_MS) response.slowMs = Math.round(selfMs);
  self.postMessage(response);
};

/** Require a spaceDid on a worker request, throwing a clear error if absent. */
function requireSpaceDid(req: WorkerRequest): string {
  if (!req.spaceDid) throw new Error("spaceDid required for this operation");
  return req.spaceDid;
}

function handleRequest(req: WorkerRequest): unknown {
  switch (req.type) {
    case "init":
      return handleInit(req);
    case "query":
      return handleQuery(req);
    case "run":
      return handleRun(req);
    case "exec":
      return handleExec(req);
    case "analyze":
      return handleAnalyze(req);
    case "prepare":
      return handlePrepare(req);
    case "prepareRun":
      return handlePrepareRun(req);
    case "prepareAll":
      return handlePrepareAll(req);
    case "prepareGet":
      return handlePrepareGet(req);
    case "prepareFinalize":
      return handlePrepareFinalize(req);
    case "transaction":
      return handleTransaction(req);
    case "close":
      return handleClose();
    case "health":
      return { ok: true };
    case "backfillEntitySpace":
      return handleBackfillEntitySpace(req);
    case "spaceRebuildBegin":
      return handleSpaceRebuildBegin(requireSpaceDid(req));
    case "spaceRebuildCommit":
      return handleSpaceRebuildCommit(requireSpaceDid(req));
    case "spaceRebuildAbort":
      return handleSpaceRebuildAbort(requireSpaceDid(req));
    case "isSpaceRebuilding":
      return handleIsSpaceRebuilding(requireSpaceDid(req));
    case "checkSpaceSchema":
      return handleCheckSpaceSchema(requireSpaceDid(req));
    case "spaceMigrationBegin":
      return handleSpaceMigrationBegin(requireSpaceDid(req));
    case "spaceMigrationEnd":
      return handleSpaceMigrationEnd(requireSpaceDid(req));
    case "isSpaceMigrating":
      return handleIsSpaceMigrating(requireSpaceDid(req));
    default:
      throw new Error(`Unknown request type: ${req.type}`);
  }
}

// ─── Entity→space index backfill ──────────────────────────────────────────

/**
 * Backfill the global `entity_space` index from a per-space DB's `entities`
 * table. Runs entirely in the worker (no round-trips): reads every entity
 * row from the per-space DB and inserts its (id, stream_id) mapping into the
 * global DB. Idempotent (`insert or ignore`).
 *
 * `openSpaceDbForEntity` resolves a room/message id to its owning
 * space via this index. Existing per-space DBs materialized before the index
 * existed (or before a schema bump) have no entries, so this backfill is run
 * on boot for every stream to make room-scoped handlers work.
 */
function handleBackfillEntitySpace(req: WorkerRequest): { backfilled: number } {
  if (role !== "global" && role !== "system") {
    throw new Error("backfillEntitySpace requires the global DB (global worker)");
  }
  if (!req.spaceDid) throw new Error("spaceDid required for backfillEntitySpace");
  const spaceDb = openSpaceDb(req.spaceDid);
  const global = openGlobalDbInternal();
  const rows = spaceDb
    .query(
      "select id, stream_id from entities where stream_id is not null and stream_id != ''",
    )
    .all() as Array<{ id: string; stream_id: string }>;
  if (rows.length === 0) return { backfilled: 0 };
  const insert = global.prepare(
    "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
  );
  const run = global.transaction(() => {
    for (const r of rows) insert.run(r.id, r.stream_id);
  });
  run();
  return { backfilled: rows.length };
}

// ─── Init ─────────────────────────────────────────────────────────────────

function handleInit(req: WorkerRequest): {
  readStateDbPath: string;
  eventsDbPath: string;
} {
  const opts = req.initOpts!;
  const readStatePath =
    opts.readStateDbPath ?? dbPath("roomy-readstate.sqlite");
  const eventsPath = opts.eventsDbPath ?? dbPath("roomy-events.sqlite");

  // Per-space split: lazily-created space DBs + global DB. When
  // any shared DB is :memory: (tests), keep the derived DBs in-memory too so
  // tests never touch the filesystem. The fallbacks are per-role below.
  const anyMemory =
    readStatePath === ":memory:" ||
    eventsPath === ":memory:" ||
    (opts.globalDbPath ?? "") === ":memory:";
  spaceSchemaVersion = opts.spaceSchemaVersion ?? "";
  globalSchemaVersion = opts.globalSchemaVersion ?? "";
  if (opts.maxSpaceDbs !== undefined) maxSpaceDbs = opts.maxSpaceDbs;
  role = opts.role ?? "system";

  // Per-space DB access is only available on roles that own (or assist the
  // ownership of) space DBs: "space" workers, the "global" worker (entity_space
  // backfill), and the legacy "system" role. The dedicated readstate/events
  // workers leave `spacesDir` null so a mis-routed space/global request fails
  // loudly instead of silently serving from the wrong worker.
  if (role === "readstate" || role === "events") {
    spacesDir = null;
    globalDbPath = null;
  } else {
    spacesDir = opts.spacesDir ?? (anyMemory ? ":memory:" : resolveSpacesDir());
    globalDbPath =
      opts.globalDbPath ?? (anyMemory ? ":memory:" : dbPath("global.sqlite"));
  }
  const openWithPragmas = (path: string): Database => {
    const db = path === ":memory:" ? new Database(":memory:") : (() => {
      mkdirSync(dirname(path), { recursive: true });
      return new Database(path, { create: true });
    })();
    db.exec("pragma journal_mode = wal");
    db.exec("pragma synchronous = normal");
    db.exec("pragma foreign_keys = on");
    db.exec("pragma busy_timeout = 5000");
    return db;
  };

  // Role-split (system-worker split): a dedicated worker per shared DB, so a
  // slow query on one DB blocks only that DB. Each role opens only
  // the DB(s) it owns; everything else stays NULL. The "space" and "global"
  // roles set `spacesDir` so space DBs can be opened lazily (the global
  // worker needs them for the entity_space backfill).
  if (role === "space") {
    return { readStateDbPath: "", eventsDbPath: "" };
  }

  if (role === "global" || role === "system") {
    // Global DB is opened lazily on first request (openGlobalDbInternal).
  }

  if (role === "readstate" || role === "system") {
    // Open read-state DB (own file, no ATTACH).
    readStateDb = openWithPragmas(readStatePath);
    initializeReadStateSchema(
      readStateDb,
      READSTATE_SCHEMA_PATH,
      opts.readStateSchemaVersion ?? "",
    );
  }

  if (role === "events" || role === "system") {
    // Open events DB (append-only, never wiped — no schema version).
    eventsDb = openWithPragmas(eventsPath);
    const eventsSchemaSql = readFileSync(EVENTS_SCHEMA_PATH, "utf-8");
    eventsDb.exec(eventsSchemaSql);

    // Add columns that were added after the table was first created.
    // SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we check the
    // table info first.
    const existingColumns = new Set(
      eventsDb
        .query<{ name: string }, []>(
          "select name from pragma_table_info('stream_events')",
        )
        .all()
        .map((r) => r.name),
    );
    if (!existingColumns.has("event_type")) {
      eventsDb.exec("alter table stream_events add column event_type text");
    }
    if (!existingColumns.has("created_at")) {
      eventsDb.exec("alter table stream_events add column created_at integer");
    }
    if (!existingColumns.has("received_at")) {
      eventsDb.exec("alter table stream_events add column received_at integer");
      // Backfill from the ingest clock the log already recorded — the same
      // observation `received_at` makes, at second instead of millisecond
      // resolution. Without this every pre-existing message would fall back to
      // its sender-minted ULID time on the next rebuild — silently re-sorting
      // history by client clocks, which is the defect `received_at` exists to
      // prevent. Only rows with no receipt time are touched, so re-running is a
      // no-op.
      //
      // This reaches only rows this appserver appended. A row with no
      // `created_at` either — history imported by
      // `scripts/migrate-from-leaf.ts`, which writes the five protocol columns
      // and nothing else — keeps the ULID fallback (`materialization/sortIdx.ts`).
      eventsDb.exec(
        "update stream_events set received_at = created_at where received_at is null and created_at is not null",
      );
    }
  }

  return {
    readStateDbPath: readStateDb ? readStatePath : "",
    eventsDbPath: eventsDb ? eventsPath : "",
  };
}

// ─── Query handlers ───────────────────────────────────────────────────────

function handleQuery(req: WorkerRequest): unknown {
  const db = dbForRequest(req);
  const stmt = db.query(req.sql!);
  if (req.mode === "get") {
    return stmt.get(...toBindings(req.params)) ?? null;
  }
  return stmt.all(...toBindings(req.params));
}

function handleRun(req: WorkerRequest): {
  changes: number;
  lastInsertRowid?: number;
} {
  const db = dbForRequest(req);
  const result = (db.run as (...args: unknown[]) => Changes)(req.sql!, ...toBindings(req.params));
  return {
    changes: result.changes,
    lastInsertRowid: normaliseRowid(result.lastInsertRowid),
  };
}

function handleExec(req: WorkerRequest): void {
  dbForRequest(req).exec(req.sql!);
}

/**
 * Refresh a DB's query-planner statistics (`sqlite_stat1`), on request.
 *
 * The boot sweep drives this for every stream and the shared DBs; a space DB
 * also refreshes itself when it is opened (see `analyzeSpaceDb`). Statistics
 * are per-database, so this resolves the request's target the same way every
 * other handler does — a shared-DB analyze routed to whatever DB `targetDb`
 * names, a space analyze to its own file.
 */
function handleAnalyze(req: WorkerRequest): { analyzed: boolean } {
  analyzeSpaceDb(dbForRequest(req));
  return { analyzed: true };
}

function handlePrepare(req: WorkerRequest): { handle: number } {
  const db = dbForRequest(req);
  const handle = nextHandle++;
  preparedStmts.set(handle, db.prepare(req.sql!));
  return { handle };
}

function handlePrepareRun(req: WorkerRequest): {
  changes: number;
  lastInsertRowid?: number;
} {
  const stmt = preparedStmts.get(req.handle!);
  if (!stmt)
    throw new Error(`Unknown prepared statement handle: ${req.handle}`);
  const result = stmt.run(...toBindings(req.params));
  return {
    changes: result.changes,
    lastInsertRowid: normaliseRowid(result.lastInsertRowid),
  };
}

function handlePrepareAll(req: WorkerRequest): unknown[] {
  const stmt = preparedStmts.get(req.handle!);
  if (!stmt)
    throw new Error(`Unknown prepared statement handle: ${req.handle}`);
  return stmt.all(...toBindings(req.params));
}

function handlePrepareGet(req: WorkerRequest): unknown {
  const stmt = preparedStmts.get(req.handle!);
  if (!stmt)
    throw new Error(`Unknown prepared statement handle: ${req.handle}`);
  return stmt.get(...toBindings(req.params)) ?? null;
}

function handlePrepareFinalize(req: WorkerRequest): void {
  const stmt = preparedStmts.get(req.handle!);
  if (stmt) {
    stmt.finalize();
    preparedStmts.delete(req.handle!);
  }
}

function handleTransaction(req: WorkerRequest): unknown {
  const db = dbForRequest(req);
  let lastResult: unknown = undefined;
  const run = db.transaction(() => {
    for (const step of req.steps ?? []) {
      switch (step.type) {
        case "query":
          lastResult = db.prepare(step.sql).all(...toBindings(step.params));
          break;
        case "run":
          lastResult = (db.run as (...args: unknown[]) => Changes)(step.sql, ...toBindings(step.params));
          break;
        case "exec":
          db.exec(step.sql);
          lastResult = undefined;
          break;
      }
    }
  });
  run();
  return lastResult;
}

function handleClose(): void {
  closed = true;
  preparedStmts.clear();
  for (const [, entry] of spaceDbs) {
    try {
      entry.db.close();
    } catch {
      /* best-effort */
    }
  }
  spaceDbs.clear();
  if (globalDb) {
    try {
      globalDb.close();
    } catch {
      /* best-effort */
    }
    globalDb = null;
  }
  if (eventsDb) {
    eventsDb.close();
    eventsDb = null;
  }
  if (readStateDb) {
    readStateDb.close();
    readStateDb = null;
  }
}
