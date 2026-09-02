/**
 * SQLite worker — runs in a Bun.Worker thread.
 *
 * Owns the read-state DB (`readStateDb`), the event-log DB (`eventsDb`),
 * the per-space DBs (`data/spaces/<spaceDid>.sqlite`), and the global DB
 * (`data/global.sqlite`). There is no monolithic materialised DB — the
 * per-space DBs are the source of truth for space data (Phase 3 of
 * docs/plans/per-space-dbs.md).
 *
 * Per-space DBs (`data/spaces/<spaceDid>.sqlite`) are opened lazily on first
 * request for that space, cached with LRU eviction, and created by
 * re-materialising that stream from the event log (not backfilled from a
 * monolithic DB). The global DB (`data/global.sqlite`) is opened lazily on
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
 * Blue-green rebuild state, keyed by spaceDid. While a rebuild is in flight the
 * canonical (old-schema) DB keeps serving reads and the temp rebuild DB at
 * `data/spaces/<spaceDid>.sqlite.new` is materialised in the background; commit
 * atomically swaps them. Keyed per space so it lands on the owning worker.
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

// ─── Schema paths ─────────────────────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SPACE_SCHEMA_PATH = join(THIS_DIR, "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(THIS_DIR, "schema-global.sql");
const READSTATE_SCHEMA_PATH = join(THIS_DIR, "readStateSchema.sql");
const EVENTS_SCHEMA_PATH = join(THIS_DIR, "eventsSchema.sql");

// ─── Schema helpers (ported from db.ts / readStateDb.ts) ──────────────────

class SchemaVersionMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Schema version mismatch: expected ${expected}, got ${actual}`,
    );
    this.name = "SchemaVersionMismatchError";
  }
}

/**
 * Schema-version tracking for a DB that keeps its own version table.
 *
 * Blue-green (P1): reads the on-disk version FIRST and only applies the schema
 * DDL to a fresh/current DB. It must never exec the *new* schema onto a stale
 * DB before deciding it is a mismatch — that would mutate the old data the
 * rebuild is meant to keep serving unchanged. A stale DB is reported via
 * `SchemaVersionMismatchError` with the file left byte-for-byte untouched.
 */
function initializeVersionedSchema(
  db: Database,
  schemaPath: string,
  versionTable: string,
  expectedVersion: string,
): void {
  let row: { version: string } | null;
  try {
    row = db
      .query<{ version: string }, []>(
        `select version from ${versionTable} where id = 1`,
      )
      .get();
  } catch {
    // No version table yet — a fresh DB. Fall through to apply schema.
    row = null;
  }

  if (!row) {
    const schema = readFileSync(schemaPath, "utf-8");
    db.exec(schema);
    db.exec(
      `insert into ${versionTable} (id, version) values (1, '${expectedVersion}')`,
    );
    return;
  }

  if (row.version !== expectedVersion) {
    throw new SchemaVersionMismatchError(expectedVersion, row.version);
  }

  // Current version: ensure the schema DDL is present (idempotent) so a DB
  // stamped as current but missing a table added in the same version heals.
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);
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
    db.exec(schema);
    db.exec(
      `insert into global_schema_version (id, version) values (1, '${expectedVersion}')`,
    );
    db.query(
      "insert or ignore into global_schema_migrations (version, completed_at) values (?, null)",
    ).run(expectedVersion);
    return;
  }

  if (row.version === expectedVersion) {
    db.exec(schema);
    db.query(
      "insert or ignore into global_schema_migrations (version, completed_at) values (?, null)",
    ).run(expectedVersion);
    return;
  }

  const actual = Number.parseInt(row.version, 10);
  const expected = Number.parseInt(expectedVersion, 10);
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || actual >= expected) {
    throw new SchemaVersionMismatchError(expectedVersion, row.version);
  }

  db.transaction(() => {
    db.exec(schema);
    db.query("update global_schema_version set version = ? where id = 1").run(expectedVersion);
    db.query(
      "insert or ignore into global_schema_migrations (version, completed_at) values (?, null)",
    ).run(expectedVersion);
  })();
}

interface Migration {
  version: number;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    up(db: Database) {
      db.exec(`
        create table if not exists user_thread_activity (
          user_did      text not null,
          thread_id     text not null,
          last_active_at integer not null,
          updated_at    integer not null default (unixepoch() * 1000),
          primary key (user_did, thread_id)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_user_thread_activity_user
          on user_thread_activity(user_did, last_active_at desc)
      `);
    },
  },
  {
    version: 3,
    up(db: Database) {
      // Web push tables. The schema file (readStateSchema.sql) also
      // declares these with `create table if not exists` so a fresh DB
      // gets them at exec time; this migration exists so an existing v2
      // readstate DB advances its version row to 3 (the schema exec alone
      // would create the tables but leave the version stale).
      db.exec(`
        create table if not exists push_subscriptions (
          user_did        text not null,
          endpoint        text not null,
          p256dh          text not null,
          auth            text not null,
          expiration_time integer,
          created_at      integer not null default (unixepoch() * 1000),
          updated_at      integer not null default (unixepoch() * 1000),
          primary key (user_did, endpoint)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_push_subs_user
          on push_subscriptions(user_did)
      `);
      db.exec(`
        create table if not exists push_user_default (
          user_did text primary key,
          level    text not null check(level in ('silent','quiet','engaged','busy')) default 'engaged',
          updated_at integer not null default (unixepoch() * 1000)
        ) strict
      `);
      db.exec(`
        create table if not exists push_preferences (
          user_did  text not null,
          space_id  text not null,
          level     text not null check(level in ('silent','quiet','engaged','busy')),
          updated_at integer not null default (unixepoch() * 1000),
          primary key (user_did, space_id)
        ) strict
      `);
      db.exec(`
        create table if not exists user_room_participation (
          user_did         text not null,
          room_id          text not null,
          last_message_at  integer not null,     -- epoch ms of the user's latest message in the room
          updated_at       integer not null default (unixepoch() * 1000),
          primary key (user_did, room_id)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_user_room_participation_user
          on user_room_participation(user_did, last_message_at desc)
      `);
      db.exec(`
        create table if not exists notification_state (
          user_did            text not null,
          room_id             text not null,
          first_unseen_at     integer,           -- epoch ms of the first unseen message in this batch
          first_unseen_msg_id text,              -- anchor message ULID
          unseen_count        integer not null default 0,
          notified            integer not null default 0 check(notified in (0,1)),
          pushed_at           integer,
          updated_at          integer not null default (unixepoch() * 1000),
          primary key (user_did, room_id)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_notification_state_due
          on notification_state(notified, first_unseen_at)
      `);
    },
  },
  {
    version: 4,
    up(db: Database) {
      // Feature flags. The schema file (readStateSchema.sql) also declares
      // these with `create table if not exists` so a fresh DB gets them at
      // exec time; this migration exists so an existing v3 readstate DB
      // advances its version row to 4.
      db.exec(`
        create table if not exists feature_flags (
          key             text primary key,
          global_enabled  integer not null default 0 check(global_enabled in (0, 1)),
          updated_at      integer not null default (unixepoch() * 1000)
        ) strict
      `);
      db.exec(`
        create table if not exists feature_flag_assignments (
          flag_key   text not null,
          user_did   text not null,
          updated_at integer not null default (unixepoch() * 1000),
          primary key (flag_key, user_did)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_ff_assignments_flag
          on feature_flag_assignments(flag_key)
      `);
    },
  },
  {
    version: 5,
    up(db: Database) {
      // Per-space split (§1f): read_positions gains a denormalized
      // `space_did` column so unread sums can be scoped per space without
      // joining entities (which moves to per-space DBs). Purely additive —
      // no data loss.
      const cols = db
        .query<{ name: string }, []>(
          "select name from pragma_table_info('read_positions')",
        )
        .all()
        .map((r) => r.name);
      if (!cols.includes("space_did")) {
        db.exec(
          "alter table read_positions add column space_did text not null default ''",
        );
      }
    },
  },
  {
    version: 6,
    up(db: Database) {
      db.exec(`
        create table if not exists readstate_schema_migrations (
          version text primary key,
          completed_at integer
        ) strict
      `);
      db.exec(`
        create table if not exists user_space_membership (
          user_did        text not null,
          space_did       text not null,
          state           text not null check(state in ('joined', 'left')),
          source          text not null,
          source_event_id text not null,
          updated_at      integer not null default (unixepoch() * 1000),
          primary key (user_did, space_did)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_user_space_membership_user_state
          on user_space_membership(user_did, state, updated_at desc)
      `);
      db.query(
        "insert or ignore into readstate_schema_migrations (version, completed_at) values ('6', null)",
      ).run();
    },
  },
  {
    version: 7,
    up(db: Database) {
      // Per-space split (§1f): user_thread_activity gains a denormalized
      // `space_did` column so the sidebar/unread queries can scope engaged
      // threads per space instead of scanning every thread the user has
      // engaged with across all spaces. Purely additive — no data loss.
      // The column is backfilled from the global `entity_space` index by the
      // v7 read-state post-migration task (see userSpaceMembershipMigration.ts).
      const cols = db
        .query<{ name: string }, []>(
          "select name from pragma_table_info('user_thread_activity')",
        )
        .all()
        .map((r) => r.name);
      if (!cols.includes("space_did")) {
        db.exec(
          "alter table user_thread_activity add column space_did text not null default ''",
        );
      }
      db.exec(`
        create index if not exists idx_user_thread_activity_user_space
          on user_thread_activity(user_did, space_did, last_active_at desc)
      `);
      db.query(
        "insert or ignore into readstate_schema_migrations (version, completed_at) values ('7', null)",
      ).run();
    },
  },
];

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
    for (const migration of MIGRATIONS) {
      if (
        migration.version > currentVersion &&
        migration.version <= expectedNum
      ) {
        db.transaction(() => {
          migration.up(db);
          upsertVersion.run(String(migration.version));
        })();
      }
    }
  }
}

// ─── Per-space DB management ──────────────────────────────────────────────

/**
 * Open (or return from the LRU cache) the per-space DB for `spaceDid`.
 * On first open: create the file and apply the per-space schema. The DB is
 * populated by re-materialising the stream from the event log (Phase 3 —
 * there is no monolithic DB to backfill from).
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
    initializeVersionedSchema(
      db,
      SPACE_SCHEMA_PATH,
      "space_schema_version",
      spaceSchemaVersion ?? "",
    );

  } catch (err) {
    if (err instanceof SchemaVersionMismatchError) {
      // Blue-green (P1): the on-disk schema is stale. Do NOT wipe it — serve
      // the OLD DB as-is so reads see pre-deploy data until an explicit
      // rebuild (spaceRebuildBegin → replay → commit) swaps it. The rebuild
      // is driven by reMaterializeFromLocalEvents, never by a read. The file
      // is left untouched (initializeVersionedSchema checks version first).
    } else {
      // The space DB must never be left half-initialised: a partial file
      // (schema applied but init failed, or worse) reads back as
      // "database disk image is malformed" on every subsequent open.
      // Close and delete it so the next open retries from scratch.
      deleteSpaceDbFile(spaceDid, db);
      throw err;
    }
  }


  // LRU eviction: close the least-recently-used handle when over capacity.
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

// ─── Blue-green rebuild (L1 seam) ─────────────────────────────────────────

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
  // Fresh new-schema DB (no version row → initializeVersionedSchema applies
  // the current schema and stamps the version).
  initializeVersionedSchema(
    rebuild,
    SPACE_SCHEMA_PATH,
    "space_schema_version",
    spaceSchemaVersion ?? "",
  );

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
  // it over the canonical file (same filesystem ⇒ atomic, P3).
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
 * Abandon a rebuild: delete the temp file and clear the rebuilding flag. The
 * old DB keeps serving (P6). Returns `{ aborted: false }` when not rebuilding.
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
  try {
    if (closed) {
      const response: WorkerResponse = {
        id: req.id,
        error: "Worker is closed",
        errorCode: "WORKER_CLOSED",
      };
      self.postMessage(response);
      return;
    }
    const result = handleRequest(req);
    const response: WorkerResponse = { id: req.id, result };
    self.postMessage(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorCode =
      err instanceof SchemaVersionMismatchError
        ? "SCHEMA_MISMATCH"
        : "INTERNAL_ERROR";
    const response: WorkerResponse = {
      id: req.id,
      error: message,
      errorCode,
    };
    self.postMessage(response);
  }
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
 * Phase 3: `openSpaceDbForEntity` resolves a room/message id to its owning
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

  // Per-space split (Phase 3): lazily-created space DBs + global DB. When
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
  // slow query on one DB no longer blocks the others. Each role opens only
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
    // Open read-state DB (own file, no ATTACH — Phase 3).
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
