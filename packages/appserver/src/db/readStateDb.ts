/**
 * SQLite handle for the appserver's read-state database.
 *
 * Separate from the materialisation DB because read_positions is
 * appserver-owned state that cannot be reconstructed from the Leaf event
 * log. The materialisation DB can be wiped and re-backfilled; this one
 * must survive across schema changes and server restarts.
 *
 * At startup the read-state DB is ATTACHed to the materialisation DB as
 * `readstate`, so SQL in materialisers and handlers can reference
 * `readstate.read_positions` for cross-database joins.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Bump whenever readStateSchema.sql changes.
 * Uses a separate versioning namespace from the materialisation DB.
 */
export const READSTATE_SCHEMA_VERSION = "1";

const DEFAULT_DB_PATH =
  process.env.READSTATE_DB_PATH ?? "data/roomy-readstate.sqlite";

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "readStateSchema.sql",
);

let dbInstance: Database | null = null;

export interface OpenReadStateDbOpts {
  /** Filesystem path or `:memory:`. Defaults to `READSTATE_DB_PATH` or `data/roomy-readstate.sqlite`. */
  path?: string;
  /** If true, skip the process-wide singleton (useful for tests). */
  isolated?: boolean;
}

/**
 * Open (or return) the read-state SQLite database, applying the schema
 * and verifying the version row.
 */
export function openReadStateDb(opts: OpenReadStateDbOpts = {}): Database {
  if (!opts.isolated && dbInstance) return dbInstance;

  const path = opts.path ?? DEFAULT_DB_PATH;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });

  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");

  initializeReadStateSchema(db);

  if (!opts.isolated) dbInstance = db;
  return db;
}

/**
 * Apply readStateSchema.sql and reconcile the version row.
 *
 * Unlike the materialisation DB (which throws on version mismatch and
 * expects a wipe + re-backfill), the read-state DB should handle
 * migrations. For now we throw on mismatch — migration logic will be
 * added when the schema actually changes.
 */
export function initializeReadStateSchema(db: Database): void {
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);

  const row = db
    .query<{ version: string }, []>(
      "select version from readstate_schema_version where id = 1",
    )
    .get();

  if (!row) {
    db.run(
      "insert into readstate_schema_version (id, version) values (1, ?)",
      [READSTATE_SCHEMA_VERSION],
    );
    return;
  }

  if (row.version !== READSTATE_SCHEMA_VERSION) {
    throw new Error(
      `Read-state schema version mismatch: on disk = ${row.version}, expected = ${READSTATE_SCHEMA_VERSION}. ` +
        `Migration is required.`,
    );
  }
}

/**
 * ATTACH the read-state database to a materialisation DB connection.
 * After this, SQL on the materialisation DB can reference
 * `readstate.read_positions` for cross-database operations.
 */
export function attachReadState(
  mainDb: Database,
  readStateDb: Database,
): void {
  const row = readStateDb
    .query<{ file: string }, []>("pragma database_list")
    .all()
    .find((r) => r.file !== "");
  const path = row?.file;
  if (!path) {
    throw new Error(
      "Cannot ATTACH an in-memory read-state DB. Use attachInMemoryReadState() for tests.",
    );
  }
  mainDb.exec(`attach database '${path}' as readstate`);
}

/**
 * Convenience for tests: create the readstate schema directly in the
 * materialisation DB as the `readstate` attached schema.
 *
 * In-memory databases cannot be ATTACHed to each other, so for tests we
 * create a file-backed temporary DB instead.
 */
export function attachInMemoryReadState(mainDb: Database): Database {
  const tmpDir = mkdtempSync(join(realpathSync(tmpdir()), "roomy-readstate-"));
  const dbPath = join(tmpDir, "readstate.sqlite");
  const readStateDb = openReadStateDb({ path: dbPath, isolated: true });
  mainDb.exec(`attach database '${dbPath}' as readstate`);
  return readStateDb;
}

/** Close + clear the singleton. Tests only. */
export function closeReadStateDb(): void {
  if (!dbInstance) return;
  dbInstance.close();
  dbInstance = null;
}
