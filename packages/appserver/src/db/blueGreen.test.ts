/**
 * Blue-green read-serving worker DB-management tests.
 *
 * Proves the raw rebuild/swap mechanism (stale-schema DB keeps serving,
 * replay→commit swap, abort) plus the changed-column read edge case (clean
 * error) and the rebuild seam (`isSpaceRebuilding` toggles exactly around the
 * rebuild window, which is what the StreamManager write gate keys off — the
 * reject itself is tested in the StreamManager suites).
 *
 * Uses a real temp `spacesDir` (not `:memory:`) because the swap is an atomic
 * file `rename()`; an in-memory DB can't express it. The event/global/read-state
 * DBs stay in-memory so the pool only touches the temp dir for space files.
 *
 * NOTE: a single pool is shared across all tests (created in `beforeAll`, torn
 * down in `afterAll`) rather than one pool per test. Creating/terminating a
 * `Bun.Worker` per test is reliable for happy-path queries, but an erroring
 * request on a worker spawned right after a sibling test terminated its worker
 * intermittently hangs under bun:test (no response within the 5s test timeout).
 * Reusing one worker for the whole file eliminates that flakiness. Each test
 * uses a unique `spaceDid` and seeds its own canonical file, so there is no
 * cross-test cache collision in the shared pool.
 *
 * Each test seeds a canonical `<spaceDid>.sqlite` at the OLD schema version
 * (version "0" vs current `SPACE_SCHEMA_VERSION`), simulating a DB that
 * predates a schema bump.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabasePool } from "./pool.ts";
import { SPACE_SCHEMA_VERSION, GLOBAL_SCHEMA_VERSION } from "./db.ts";
import { READSTATE_SCHEMA_VERSION } from "./readStateDb.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(THIS_DIR, "schema-space.sql");
const OLD_VERSION = "0"; // simulates a DB written before SPACE_SCHEMA_VERSION bumped

let pool: DatabasePool;
let spacesDir: string;
let nextSpace = 0;
/** Current test's spaceDid + its file paths (set in beforeEach). */
let SPACE: string;
let canonicalPath: string;
let tmpPath: string;

/** Seed an old-schema canonical DB file (version OLD_VERSION) with one entity. */
function seedOldSpaceDb() {
  const db = new Database(canonicalPath, { create: true });
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.run("insert into space_schema_version (id, version) values (1, ?)", [
    OLD_VERSION,
  ]);
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    "entity-old",
    SPACE,
  ]);
  db.close();
}

beforeAll(async () => {
  spacesDir = mkdtempSync(join(tmpdir(), "roomy-bluegreen-"));
  pool = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
  await pool.init({
    readStateDbPath: ":memory:",
    eventsDbPath: ":memory:",
    globalDbPath: ":memory:",
    spacesDir,
    readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
    spaceSchemaVersion: SPACE_SCHEMA_VERSION,
    globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
  });
});

afterAll(async () => {
  await pool.close();
  rmSync(spacesDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Unique space per test + a clean file slate for it.
  SPACE = `did:plc:blue-green-${nextSpace++}`;
  canonicalPath = join(spacesDir, `${SPACE}.sqlite`);
  tmpPath = `${canonicalPath}.new`;
  for (const f of [canonicalPath, tmpPath]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(f + suffix);
      } catch {
        /* already gone */
      }
    }
  }
});

describe("blue-green read serving (worker seam)", () => {
  test("a stale-schema DB serves reads unchanged and is never wiped", async () => {
    seedOldSpaceDb();

    // checkSpaceSchema flags it stale, but reads still return old data.
    const { current } = await pool.checkSpaceSchema(SPACE);
    expect(current).toBe(false);

    const row = await pool
      .forSpace(SPACE)
      .query("select id from entities where id = ?")
      .get<{ id: string }>("entity-old");
    expect(row?.id).toBe("entity-old");

    // The canonical file must still exist and be untouched (not wiped).
    expect(existsSync(canonicalPath)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("forSpaceRebuild returns a fresh new-schema DB; canonical untouched", async () => {
    seedOldSpaceDb();

    const rebuild = pool.forSpaceRebuild(SPACE);
    // New-schema DB is empty (fresh) and writable.
    await rebuild.run("insert into entities (id, stream_id) values (?, ?)", [
      "entity-new",
      SPACE,
    ]);

    // Canonical still serves only the old row.
    const rows = await pool
      .forSpace(SPACE)
      .query("select id from entities order by id")
      .all<{ id: string }>();
    expect(rows.map((r) => r.id)).toEqual(["entity-old"]);

    // Rebuild handle sees its own new data.
    const newRows = await rebuild
      .query("select id from entities order by id")
      .all<{ id: string }>();
    expect(newRows.map((r) => r.id)).toEqual(["entity-new"]);

    // The temp rebuild file exists on disk during the window.
    expect(existsSync(tmpPath)).toBe(true);
  });

  test("replay → commit makes reads see new data and drops the old file", async () => {
    seedOldSpaceDb();

    const rebuild = pool.forSpaceRebuild(SPACE);
    await rebuild.run("insert into entities (id, stream_id) values (?, ?)", [
      "entity-new",
      SPACE,
    ]);
    // Old DB still serving during the window.
    const oldRow = await pool
      .forSpace(SPACE)
      .query("select id from entities where id = ?")
      .get<{ id: string }>("entity-old");
    expect(oldRow?.id).toBe("entity-old");

    const { committed } = await pool.spaceRebuildCommit(SPACE);
    expect(committed).toBe(true);

    // Canonical now serves the new data.
    const rows = await pool
      .forSpace(SPACE)
      .query("select id from entities order by id")
      .all<{ id: string }>();
    expect(rows.map((r) => r.id)).toEqual(["entity-new"]);

    // Temp file gone; only canonical remains.
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(canonicalPath)).toBe(true);
  });

  test("commit is idempotent and the space is current + not rebuilding after", async () => {
    seedOldSpaceDb();

    const rebuild = pool.forSpaceRebuild(SPACE);
    await rebuild.run("insert into entities (id, stream_id) values (?, ?)", [
      "entity-new",
      SPACE,
    ]);
    expect(await pool.isSpaceRebuilding(SPACE)).toBe(true);

    expect((await pool.spaceRebuildCommit(SPACE)).committed).toBe(true);
    // Second commit is a no-op, not an error.
    expect((await pool.spaceRebuildCommit(SPACE)).committed).toBe(false);

    // Post-swap the space is on the current schema and no longer rebuilding.
    expect((await pool.checkSpaceSchema(SPACE)).current).toBe(true);
    expect(await pool.isSpaceRebuilding(SPACE)).toBe(false);
  });

  test("cursor written during rebuild is readable after swap", async () => {
    seedOldSpaceDb();

    const rebuild = pool.forSpaceRebuild(SPACE);
    await rebuild.run(
      "insert into materialization_cursor (stream_id, materialized_to) values (?, ?)",
      [SPACE, 42],
    );
    await pool.spaceRebuildCommit(SPACE);

    const cursor = await pool
      .forSpace(SPACE)
      .query(
        "select materialized_to from materialization_cursor where stream_id = ?",
      )
      .get<{ materialized_to: number }>(SPACE);
    expect(cursor?.materialized_to).toBe(42);
  });

  test("abort keeps the old DB serving and removes the temp file", async () => {
    seedOldSpaceDb();

    const rebuild = pool.forSpaceRebuild(SPACE);
    await rebuild.run("insert into entities (id, stream_id) values (?, ?)", [
      "entity-new",
      SPACE,
    ]);
    expect((await pool.spaceRebuildAbort(SPACE)).aborted).toBe(true);

    // Old data still served; temp gone.
    const rows = await pool
      .forSpace(SPACE)
      .query("select id from entities order by id")
      .all<{ id: string }>();
    expect(rows.map((r) => r.id)).toEqual(["entity-old"]);
    expect(existsSync(tmpPath)).toBe(false);
    expect(await pool.isSpaceRebuilding(SPACE)).toBe(false);

    // Aborting when nothing is rebuilding is a no-op, not an error.
    expect((await pool.spaceRebuildAbort(SPACE)).aborted).toBe(false);
  });

  test("a read touching a column missing from the old schema errors cleanly", async () => {
    seedOldSpaceDb();

    // The old-schema DB lacks `some_new_column` (a column added by the new
    // schema). Reading it during the window must reject with a clear error,
    // not silently return wrong data or 500.
    await expect(
      pool.forSpace(SPACE).query("select some_new_column from entities").all(),
    ).rejects.toThrow(/some_new_column/);
  });

  test("isSpaceRebuilding toggles exactly around the rebuild window", async () => {
    seedOldSpaceDb();

    expect(await pool.isSpaceRebuilding(SPACE)).toBe(false);

    // Explicit begin marks the space rebuilding immediately (no request needed).
    await pool.spaceRebuildBegin(SPACE);
    expect(await pool.isSpaceRebuilding(SPACE)).toBe(true);

    await pool.spaceRebuildCommit(SPACE);
    expect(await pool.isSpaceRebuilding(SPACE)).toBe(false);
  });

  test("a fresh (missing) canonical file is considered current schema", async () => {
    // No file seeded — a brand-new space.
    expect((await pool.checkSpaceSchema(SPACE)).current).toBe(true);
    expect(await pool.isSpaceRebuilding(SPACE)).toBe(false);
  });
});
