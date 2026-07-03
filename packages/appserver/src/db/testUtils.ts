/**
 * Test utilities for creating in-memory databases with schema applied.
 *
 * Test files use `new Database(":memory:")` for synchronous seed data, then
 * wrap with `toAsyncDb` for the async DbLike interface. This module provides
 * a helper that applies the schema so tables exist.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "./syncAdapter.ts";
import type { DbLike } from "./types.ts";

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "schema.sql",
);
const READSTATE_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "readStateSchema.sql",
);

/**
 * Create an in-memory Database with the main schema applied.
 * Returns both the raw `Database` (for synchronous seed data) and
 * the async `DbLike` wrapper (for async query functions).
 */
export function openTestDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");

  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);

  return { db, asyncDb: toAsyncDb(db) };
}

/**
 * Create an in-memory Database with both the main schema and the read-state
 * schema applied. The read-state tables are created in the main database
 * (no ATTACH needed for in-memory tests).
 * Returns both the raw `Database` and the async `DbLike` wrapper.
 */
export function openTestDbWithReadState(): { db: Database; asyncDb: DbLike } {
  const { db, asyncDb } = openTestDb();

  const readStateSql = readFileSync(READSTATE_SCHEMA_PATH, "utf8");
  // Replace the schema version table name to avoid collision
  const adjustedSql = readStateSql.replace(
    "readstate_schema_version",
    "readstate_schema_version",
  );
  db.exec(adjustedSql);

  return { db, asyncDb };
}
