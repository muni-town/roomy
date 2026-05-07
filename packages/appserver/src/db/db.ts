/**
 * SQLite handle for the appserver's materialised view.
 *
 * One process-wide database, opened lazily. The schema in `./schema.sql`
 * mirrors the frontend worker schema so the SDK's pure materializer functions
 * can be reused unchanged.
 *
 * Materialisation is fully deterministic from the Leaf event log, so on a
 * schema-version mismatch the safe move is to drop the file and re-backfill.
 * For now we throw — wiring the wipe-on-mismatch path lives with the bootstrap
 * step (step 4 of the materialisation plan).
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bump whenever schema.sql changes. Mirrors the frontend's
 * `CONFIG.databaseSchemaVersion`. Strings, not numbers, so we can use
 * suffixes (e.g. `"6-appserver.1"`) once the two diverge.
 */
export const SCHEMA_VERSION = "6-appserver.1";

const DEFAULT_DB_PATH = process.env.APPSERVER_DB_PATH ?? "data/roomy.sqlite";

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "schema.sql",
);

let dbInstance: Database | null = null;

export interface OpenDbOptions {
  /** Filesystem path or `:memory:`. Defaults to `APPSERVER_DB_PATH` or `data/roomy.sqlite`. */
  path?: string;
  /** If true, skip the process-wide singleton (useful for tests). */
  isolated?: boolean;
}

/**
 * Open (or return) the appserver's SQLite database, applying the schema and
 * verifying the version row.
 */
export function openDb(opts: OpenDbOptions = {}): Database {
  if (!opts.isolated && dbInstance) return dbInstance;

  const path = opts.path ?? DEFAULT_DB_PATH;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });

  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");

  initializeSchema(db);

  if (!opts.isolated) dbInstance = db;
  return db;
}

/**
 * Apply schema.sql and reconcile the schema version row.
 *
 * Throws if the on-disk version differs from `SCHEMA_VERSION` — the caller is
 * expected to wipe the file and re-open. Idempotent on a matching DB.
 */
export function initializeSchema(db: Database): void {
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  // bun:sqlite executes multi-statement scripts via `exec`. Statements are
  // separated by semicolons; CREATE TABLE / INDEX / VIRTUAL TABLE all parse
  // correctly without splitting.
  db.exec(schemaSql);

  const row = db
    .query<{ version: string }, []>("select version from roomy_schema_version where id = 1")
    .get();

  if (!row) {
    db.run(
      "insert into roomy_schema_version (id, version) values (1, ?)",
      [SCHEMA_VERSION],
    );
    return;
  }

  if (row.version !== SCHEMA_VERSION) {
    throw new SchemaVersionMismatchError(row.version, SCHEMA_VERSION);
  }
}

export class SchemaVersionMismatchError extends Error {
  readonly onDiskVersion: string;
  readonly expectedVersion: string;

  constructor(onDiskVersion: string, expectedVersion: string) {
    super(
      `Roomy SQLite schema version mismatch: on disk = ${onDiskVersion}, expected = ${expectedVersion}. ` +
        `Materialisation is deterministic; delete the DB file and re-backfill.`,
    );
    this.name = "SchemaVersionMismatchError";
    this.onDiskVersion = onDiskVersion;
    this.expectedVersion = expectedVersion;
  }
}

/** Close + clear the singleton. Tests only. */
export function closeDb(): void {
  if (!dbInstance) return;
  dbInstance.close();
  dbInstance = null;
}
