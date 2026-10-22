/**
 * A read for a space id that is not a space must not create a per-space DB.
 *
 * Opening a space's DB creates the file and applies the whole per-space schema
 * (~372 KB), so `getMetadata` / `getSpaceSummary` for an unknown id used to
 * leave one behind for every 404: files nothing deleted, competing with real
 * spaces for each worker's LRU cache. Both handlers now prove the space exists
 * from the global `entity_space` index before they open anything.
 *
 * The boot sweep (`reMaterializeFromLocalEvents` → `sweepEmptySpaceDbs`) covers
 * files left by earlier builds. It only removes a file that the index does not
 * know AND that holds no materialised row, so a real space's DB is never
 * touched.
 *
 * Uses a real temp `DATA_DIR`: a `:memory:` DB cannot show a file, and
 * `spacesDir` is `<DATA_DIR>/spaces`.
 *
 * Run: bun test --cwd packages/appserver src/e2e/unknownSpaceDb.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppserver, type AppserverHandle } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb } from "../db/db.ts";
import type { PooledDatabase } from "../db/pool.ts";
import { _resetRateLimit } from "../xrpc/rateLimit.ts";
import { _resetEmbedSweeper, stopEmbedSweeper } from "../embed/sweeper.ts";
import { stopSearchIndexer, _resetSearchIndexer } from "../search/indexer.ts";
import { stopSearchBackfill, _resetSearchBackfill } from "../search/backfill.ts";
import { _resetQdrantClient, _resetMessagesCollection } from "../search/qdrantSearch.ts";
import { _resetProfileStoreCache, _setTestGetProfiles } from "../queries/profileStore.ts";
import { _setTestGetRoomyProfileRecord } from "../materialization/roomyProfile.ts";
import { _setTestFetchBlockRecords } from "../materialization/blocks.ts";
import { _resetProfileNegativeCache } from "../materialization/profiles.ts";
import { seedSpace, seedJoinedSpace } from "./helpers.ts";

const SPACE_SCHEMA_SQL = join(
  dirname(fileURLToPath(import.meta.url)),
  "../db/schema-space.sql",
);

const USER = "did:plc:unknown-db-user";
const OTHER_USER = "did:plc:unknown-db-other";
const SPACE = "did:web:unknown-db-space.example";
const UNKNOWN = "did:web:never-materialised.example";

let dataDir: string;
let spacesDir: string;
let prevDataDir: string | undefined;
let handle: AppserverHandle;
let baseUrl: string;
let db: Database;

/**
 * Write the file an unknown-space open leaves behind: a fully initialised
 * per-space DB with no rows. Backdated so the sweep's "created before this
 * worker started" guard admits it.
 */
function seedResidue(
  spaceId: string,
  entities: Array<[string, string]>,
): string {
  const path = join(spacesDir, `${spaceId}.sqlite`);
  const raw = new Database(path, { create: true });
  raw.exec(readFileSync(SPACE_SCHEMA_SQL, "utf8"));
  for (const [id, streamId] of entities) {
    raw.run("insert into entities (id, stream_id) values (?, ?)", [id, streamId]);
  }
  raw.close();
  utimesSync(path, new Date(0), new Date(0));
  return path;
}

beforeAll(async () => {
  await stopEmbedSweeper();
  await stopSearchIndexer();
  await stopSearchBackfill();
  closeDb();
  _resetRateLimit();
  _resetEmbedSweeper();
  _resetSearchIndexer();
  _resetSearchBackfill();
  _resetQdrantClient();
  _resetMessagesCollection();
  _resetProfileStoreCache();
  _resetProfileNegativeCache();
  _setTestGetProfiles(async () => []);
  _setTestGetRoomyProfileRecord(async () => null);
  _setTestFetchBlockRecords(async () => []);

  dataDir = mkdtempSync(join(tmpdir(), "roomy-unknown-space-"));
  prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  spacesDir = join(dataDir, "spaces");
  mkdirSync(spacesDir, { recursive: true });

  handle = await createAppserver({
    authVerifier: testAuthVerifier,
    port: 0,
    quiet: true,
    disableBackgroundWorkers: true,
  });
  baseUrl = `http://localhost:${handle.port}`;
  db = openDb() as unknown as Database;
});

afterEach(() => {
  _resetEmbedSweeper();
  _resetSearchIndexer();
  _resetSearchBackfill();
  _resetQdrantClient();
  _resetMessagesCollection();
  _resetProfileStoreCache();
  _resetProfileNegativeCache();
});

afterAll(async () => {
  await handle?.close();
  closeDb();
  _setTestGetProfiles(null);
  _setTestGetRoomyProfileRecord(null);
  _setTestFetchBlockRecords(null);
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("space metadata for an id that is not a space", () => {
  test("getMetadata 404s without leaving a space DB behind", async () => {
    const res = await fetch(
      `${baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${encodeURIComponent(UNKNOWN)}`,
      { headers: { "X-Test-Did": USER } },
    );
    expect(res.status).toBe(404);
    expect(existsSync(join(spacesDir, `${UNKNOWN}.sqlite`))).toBe(false);
  });

  test("getSpaceSummary 404s without leaving a space DB behind", async () => {
    const res = await fetch(
      `${baseUrl}/xrpc/space.roomy.space.getSpaceSummary?spaceId=${encodeURIComponent(UNKNOWN)}`,
      { headers: { "X-Test-Did": USER } },
    );
    expect(res.status).toBe(404);
    expect(existsSync(join(spacesDir, `${UNKNOWN}.sqlite`))).toBe(false);
  });

  test("a member still gets the space's metadata and sidebar", async () => {
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);

    const res = await fetch(
      `${baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${encodeURIComponent(SPACE)}`,
      { headers: { "X-Test-Did": USER } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Test Space");
    expect(body.isMember).toBe(true);
    expect(Array.isArray(body.sidebar.orphans)).toBe(true);
    expect(existsSync(join(spacesDir, `${SPACE}.sqlite`))).toBe(true);
  });

  test("a non-member still gets the join-screen fields", async () => {
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);

    const res = await fetch(
      `${baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${encodeURIComponent(SPACE)}`,
      { headers: { "X-Test-Did": OTHER_USER } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Test Space");
    expect(body.joinPolicy).toBeDefined();
    expect(body.isMember).toBe(false);
    expect(body.sidebar.orphans).toEqual([]);
  });
});

describe("the boot sweep of empty space DBs", () => {
  test("removes a space DB with no rows and no index entry, keeps real ones", async () => {
    const residue = seedResidue("did:web:residue.example", []);
    const real = seedResidue("did:web:real-but-unindexed.example", [
      ["01REALENTITY000000000000000", "did:web:real-but-unindexed.example"],
    ]);

    const swept = await (openDb() as PooledDatabase).sweepEmptySpaceDbs();
    expect(swept.scanned).toBeGreaterThanOrEqual(2);
    expect(swept.deleted).toBeGreaterThanOrEqual(1);
    expect(existsSync(residue)).toBe(false);
    expect(existsSync(real)).toBe(true);
  });

  test("keeps a DB the index knows even when it is empty", async () => {
    // Seeded through the real space path, so `entity_space` has rows for it.
    seedSpace(db, SPACE, USER);
    const path = join(spacesDir, `${SPACE}.sqlite`);

    await (openDb() as PooledDatabase).sweepEmptySpaceDbs();
    expect(existsSync(path)).toBe(true);
  });
});
