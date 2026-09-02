/**
 * E2E migration tests: boot the appserver against a persistent (file-based)
 * read-state DB pre-seeded at an OLDER schema version, and verify the schema
 * migration runs and the endpoints that depend on the migrated schema work.
 *
 * This is the regression guard for the class of bug where a schema file
 * references a column that only a migration adds — on an existing DB the
 * schema exec throws before the migration runs, and every query against the
 * new column fails with "no such column". The standard e2e suite uses
 * `:memory:` DBs (always fresh), so it can never catch this; only a
 * file-based DB at an older version exercises the migration path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppserver } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb, openReadStateDb } from "../db/db.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { _resetSearchIndexer } from "../search/indexer.ts";
import { _resetSearchBackfill } from "../search/backfill.ts";
import { _resetQdrantClient, _resetMessagesCollection } from "../search/qdrantSearch.ts";
import { _resetProfileStoreCache, _setTestGetProfiles } from "../queries/profileStore.ts";
import { newUlid } from "@roomy-space/sdk";
import { seedSpace, seedJoinedSpace, seedRoom, readStateDb } from "./helpers.ts";

const USER = "did:plc:migration-test-user";
const SPACE = "did:web:migration-test-space";

/**
 * Create a read-state DB file at schema v6: `user_thread_activity` WITHOUT the
 * `space_did` column (the pre-v7 shape), version row = 6. This is the exact
 * on-disk state that triggered the "no such column: uta.space_did" production
 * incident.
 */
function createV6ReadStateDb(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`
    create table readstate_schema_version (
      id integer primary key check (id = 1),
      version text not null
    ) strict
  `);
  db.exec("insert into readstate_schema_version (id, version) values (1, '6')");
  db.exec(`
    create table user_thread_activity (
      user_did      text not null,
      thread_id     text not null,
      last_active_at integer not null,
      updated_at    integer not null default (unixepoch() * 1000),
      primary key (user_did, thread_id)
    ) strict
  `);
  db.close();
}

describe("e2e: read-state schema migration on an existing DB", () => {
  let tmp: string;
  let prevDataDir: string | undefined;
  let handle: Awaited<ReturnType<typeof createAppserver>>;
  let baseUrl: string;

  afterEach(async () => {
    await handle?.close();
    closeDb();
    _resetHydrationInflight();
    _resetEmbedSweeper();
    _resetSearchIndexer();
    _resetSearchBackfill();
    _resetQdrantClient();
    _resetMessagesCollection();
    _resetProfileStoreCache();
    _setTestGetProfiles(null);
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("boots against a v6 read-state DB, migrates it, and serves the affected endpoints", async () => {
    tmp = mkdtempSync(join(tmpdir(), "roomy-mig-"));
    prevDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmp;

    // Pre-seed the read-state DB at v6 (user_thread_activity without space_did).
    createV6ReadStateDb(join(tmp, "roomy-readstate.sqlite"));

    // Boot the appserver against the file-based DBs (DATA_DIR drives all paths).
    const db = openDb() as unknown as Database;
    handle = await createAppserver({
      authVerifier: testAuthVerifier,
      port: 0,
      quiet: true,
      disableBackgroundWorkers: true,
      getProfiles: async () => [],
    });
    baseUrl = `http://localhost:${handle.port}`;

    // The v7 migration must have added the column during worker init.
    const cols = await openReadStateDb()
      .query("select name from pragma_table_info('user_thread_activity')")
      .all<{ name: string }>();
    expect(cols.map((c) => c.name)).toContain("space_did");

    // Seed a joined space with an engaged thread so getSpaces runs the
    // per-space user_thread_activity query (the one that failed in prod).
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);
    const thread = newUlid();
    seedRoom(db, thread, SPACE, "space.roomy.thread");
    readStateDb(db).run(
      `insert into user_thread_activity (user_did, thread_id, space_did, last_active_at, updated_at)
       values (?, ?, ?, ?, ?)`,
      [USER, thread, SPACE, Date.now(), Date.now()],
    );

    const authedFetch = (did: string) => (url: string, init?: RequestInit) =>
      fetch(url, {
        ...init,
        headers: { ...init?.headers, "X-Test-Did": did, "Content-Type": "application/json" },
      });

    // getSpaces → getSpaceUnreadStats → queries user_thread_activity with
    // space_did. If the migration didn't run, this throws "no such column".
    const res = await authedFetch(USER)(`${baseUrl}/xrpc/space.roomy.space.getSpaces?includeLeft=false`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spaces).toHaveLength(1);
    expect(body.spaces[0].id).toBe(SPACE);
  });
});
