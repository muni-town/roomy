/**
 * SQLite handle for the appserver's materialised view.
 *
 * One process-wide database, opened lazily. The schema in `./schema.sql`
 * mirrors the frontend worker schema so the SDK's pure materializer functions
 * can be reused unchanged.
 *
 * Materialisation is fully deterministic from the Leaf event log, so on a
 * schema-version mismatch the file is automatically deleted and re-created.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bump whenever schema.sql OR materialiser logic changes — a bump triggers
 * a wipe + full re-materialisation from the Leaf log, which is how a
 * materialiser change is rolled out to existing data. Mirrors the frontend's
 * `CONFIG.databaseSchemaVersion`. Strings, not numbers, so we can use
 * suffixes (e.g. `"6-appserver.1"`) once the two diverge.
 *
 * `.7`: getSpaces/hydration now read membership from `joinedSpace` edges
 * instead of `comp_space.hidden`; needs a re-materialise to seed the edges.
 */
export const SCHEMA_VERSION = "7-appserver.7";

const DEFAULT_DB_PATH = process.env.APPSERVER_DB_PATH ?? "data/roomy.sqlite";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

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
 *
 * On schema-version mismatch the file is deleted and recreated (materialisation
 * is deterministic from the Leaf event log so this is always safe).
 */
export function openDb(opts: OpenDbOptions = {}): Database {
  if (!opts.isolated && dbInstance) return dbInstance;

  const path = opts.path ?? DEFAULT_DB_PATH;
  const isFile = path !== ":memory:";

  if (isFile) mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true });
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");

  try {
    initializeSchema(db);
  } catch (err) {
    if (err instanceof SchemaVersionMismatchError && isFile) {
      db.close();
      console.warn(
        `[db] Schema version mismatch (${err.onDiskVersion} → ${err.expectedVersion}). ` +
          "Wiping and re-creating.",
      );
      // Remove the DB file and its WAL/SHM companions.
      for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(path + suffix); } catch { /* already gone */ }
      }
      mkdirSync(dirname(path), { recursive: true });
      const rebuilt = new Database(path, { create: true });
      rebuilt.exec("pragma journal_mode = wal");
      rebuilt.exec("pragma synchronous = normal");
      rebuilt.exec("pragma foreign_keys = on");
      initializeSchema(rebuilt);
      if (!opts.isolated) dbInstance = rebuilt;
      return rebuilt;
    }
    throw err;
  }

  if (!opts.isolated) dbInstance = db;
  return db;
}

/**
 * Apply schema.sql and write the schema version row.
 *
 * Throws `SchemaVersionMismatchError` if the on-disk version differs from
 * `SCHEMA_VERSION`. The caller (`openDb`) catches this and auto-wipes.
 * Idempotent on a matching DB.
 */
export function initializeSchema(db: Database): void {
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  // bun:sqlite executes multi-statement scripts via `exec`. Statements are
  // separated by semicolons; CREATE TABLE / INDEX / VIRTUAL TABLE all parse
  // correctly without splitting.
  db.exec(schemaSql);

  const row = db
    .query<
      { version: string },
      []
    >("select version from roomy_schema_version where id = 1")
    .get();

  if (!row) {
    db.run("insert into roomy_schema_version (id, version) values (1, ?)", [
      SCHEMA_VERSION,
    ]);
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
