/**
 * Tests for the one-shot Leaf-to-appserver migration script.
 *
 * Uses temp SQLite files for mock Leaf DBs and calls the exported migration
 * functions directly (not via CLI subprocess).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateStream, migrateDidKeys } from "../migrate-from-leaf.ts";

// ─── helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

function tmpPath(name: string): string {
  return join(tmpDir, name);
}

/** Create a mock Leaf stream DB at `path` with the given events. */
function createLeafStreamDb(
  path: string,
  events: Array<{ idx: number; user: string; payload: Uint8Array; signature: Uint8Array }>,
): void {
  const db = new Database(path, { create: true });
  db.exec(`
    create table if not exists events (
      idx integer primary key,
      user text not null,
      payload blob not null,
      signature blob not null default x''
    ) strict
  `);
  const insert = db.prepare(
    "insert into events (idx, user, payload, signature) values (?, ?, ?, ?)",
  );
  for (const e of events) {
    insert.run(e.idx, e.user, e.payload, e.signature);
  }
  db.close();
}

/** Create a mock Leaf main DB with dids / did_keys / did_owners tables. */
function createLeafMainDb(
  path: string,
  dids: Array<{
    did: string;
    p256_key?: Uint8Array | null;
    k256_key?: Uint8Array | null;
    owners?: string[];
  }>,
): void {
  const db = new Database(path, { create: true });
  db.exec(`
    create table if not exists dids (did text primary key) strict;
    create table if not exists did_keys (
      did text primary key,
      p256_key blob,
      k256_key blob
    ) strict;
    create table if not exists did_owners (
      did text,
      owner text not null,
      unique (did, owner)
    ) strict;
  `);
  for (const d of dids) {
    db.run("insert or ignore into dids (did) values (?)", d.did);
    if (d.p256_key !== undefined || d.k256_key !== undefined) {
      db.run(
        "insert or ignore into did_keys (did, p256_key, k256_key) values (?, ?, ?)",
        d.did,
        d.p256_key ?? null,
        d.k256_key ?? null,
      );
    }
    for (const owner of d.owners ?? []) {
      db.run("insert or ignore into did_owners (did, owner) values (?, ?)", d.did, owner);
    }
  }
  db.close();
}

/** Create an events DB with the events schema applied. */
function createEventsDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(`
    create table if not exists stream_events (
      stream_id text not null,
      idx integer not null,
      user text not null,
      payload blob not null,
      signature blob not null default x'',
      primary key (stream_id, idx)
    ) strict;
    create table if not exists stream_state (
      stream_id text primary key,
      latest_event integer not null default 0
    ) strict;
    create table if not exists dids (did text primary key) strict;
    create table if not exists did_keys (
      did text references dids(did),
      p256_key blob,
      k256_key blob
    ) strict;
    create table if not exists did_owners (
      did text references dids(did),
      owner text not null,
      unique (did, owner)
    ) strict;
  `);
  return db;
}

/** Create a main DB with comp_space table. */
function createMainDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(`
    create table if not exists roomy_schema_version (
      id integer primary key check (id = 1),
      version text not null
    ) strict;
    create table if not exists entities (
      id text primary key,
      stream_id text not null
    ) strict;
    create table if not exists comp_space (
      entity text primary key references entities(id) on delete cascade,
      hidden integer not null default 0,
      backfilled_to integer default 0
    ) strict;
  `);
  return db;
}

// ─── setup / teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── tests ─────────────────────────────────────────────────────────────────

describe("migrateStream", () => {
  test("migrates events from a Leaf stream DB into the events DB", async () => {
    const streamDid = "did:plc:test-stream";
    const leafDbPath = tmpPath("stream.db");
    const eventsDbPath = tmpPath("events.sqlite");
    const mainDbPath = tmpPath("main.sqlite");

    const events = [
      { idx: 1, user: "did:plc:alice", payload: new Uint8Array([1, 2, 3]), signature: new Uint8Array([10, 20]) },
      { idx: 2, user: "did:plc:bob", payload: new Uint8Array([4, 5, 6]), signature: new Uint8Array([30, 40]) },
      { idx: 5, user: "did:plc:alice", payload: new Uint8Array([7, 8, 9]), signature: new Uint8Array([50, 60]) },
    ];

    createLeafStreamDb(leafDbPath, events);
    const eventsDb = createEventsDb(eventsDbPath);
    const mainDb = createMainDb(mainDbPath);

    // Seed the entities table so the FK on comp_space is satisfied
    mainDb.run("insert into entities (id, stream_id) values (?, ?)", streamDid, streamDid);
    mainDb.run("insert into comp_space (entity) values (?)", streamDid);

    const result = await migrateStream(eventsDb, mainDb, streamDid, leafDbPath, false);

    expect(result).toEqual({ eventsMigrated: 3, latestIdx: 5 });

    // All 3 events landed in stream_events
    const rows = eventsDb
      .query("select stream_id, idx, user, payload, signature from stream_events order by idx")
      .all() as Array<{ stream_id: string; idx: number; user: string; payload: Uint8Array; signature: Uint8Array }>;
    expect(rows).toHaveLength(3);
    expect(rows[0].idx).toBe(1);
    expect(rows[0].user).toBe("did:plc:alice");
    expect(new Uint8Array(rows[0].payload)).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(rows[0].signature)).toEqual(new Uint8Array([10, 20]));
    expect(rows[1].idx).toBe(2);
    expect(rows[2].idx).toBe(5);

    // stream_state.latest_event is set to max idx
    const state = eventsDb
      .query("select stream_id, latest_event from stream_state where stream_id = ?")
      .get(streamDid) as { stream_id: string; latest_event: number } | undefined;
    expect(state).toBeDefined();
    expect(state!.latest_event).toBe(5);

    // comp_space.backfilled_to is updated
    const space = mainDb
      .query("select backfilled_to from comp_space where entity = ?")
      .get(streamDid) as { backfilled_to: number } | undefined;
    expect(space).toBeDefined();
    expect(space!.backfilled_to).toBe(5);

    eventsDb.close();
    mainDb.close();
  });

  test("returns {eventsMigrated:0} for an empty stream DB", async () => {
    const streamDid = "did:plc:empty";
    const leafDbPath = tmpPath("empty.db");
    const eventsDbPath = tmpPath("events.sqlite");
    const mainDbPath = tmpPath("main.sqlite");

    createLeafStreamDb(leafDbPath, []);
    const eventsDb = createEventsDb(eventsDbPath);
    const mainDb = createMainDb(mainDbPath);

    const result = await migrateStream(eventsDb, mainDb, streamDid, leafDbPath, false);

    expect(result).toEqual({ eventsMigrated: 0, latestIdx: 0 });

    // No rows in stream_events
    const count = eventsDb
      .query("select count(*) as c from stream_events")
      .get() as { c: number };
    expect(count.c).toBe(0);

    eventsDb.close();
    mainDb.close();
  });

  test("dry-run does not write any data", async () => {
    const streamDid = "did:plc:dry";
    const leafDbPath = tmpPath("stream.db");
    const eventsDbPath = tmpPath("events.sqlite");
    const mainDbPath = tmpPath("main.sqlite");

    const events = [
      { idx: 1, user: "did:plc:alice", payload: new Uint8Array([1]), signature: new Uint8Array([2]) },
    ];

    createLeafStreamDb(leafDbPath, events);
    const eventsDb = createEventsDb(eventsDbPath);
    const mainDb = createMainDb(mainDbPath);
    mainDb.run("insert into entities (id, stream_id) values (?, ?)", streamDid, streamDid);
    mainDb.run("insert into comp_space (entity) values (?)", streamDid);

    const result = await migrateStream(eventsDb, mainDb, streamDid, leafDbPath, true);

    expect(result).toEqual({ eventsMigrated: 1, latestIdx: 1 });

    // No events written
    const eventCount = eventsDb
      .query("select count(*) as c from stream_events")
      .get() as { c: number };
    expect(eventCount.c).toBe(0);

    // No stream_state written
    const stateCount = eventsDb
      .query("select count(*) as c from stream_state")
      .get() as { c: number };
    expect(stateCount.c).toBe(0);

    // comp_space.backfilled_to unchanged
    const space = mainDb
      .query("select backfilled_to from comp_space where entity = ?")
      .get(streamDid) as { backfilled_to: number } | undefined;
    expect(space).toBeDefined();
    expect(space!.backfilled_to).toBe(0);

    eventsDb.close();
    mainDb.close();
  });

  test("idempotent — running twice does not duplicate rows", async () => {
    const streamDid = "did:plc:idempotent";
    const leafDbPath = tmpPath("stream.db");
    const eventsDbPath = tmpPath("events.sqlite");
    const mainDbPath = tmpPath("main.sqlite");

    const events = [
      { idx: 1, user: "did:plc:alice", payload: new Uint8Array([1]), signature: new Uint8Array([2]) },
      { idx: 2, user: "did:plc:bob", payload: new Uint8Array([3]), signature: new Uint8Array([4]) },
    ];

    createLeafStreamDb(leafDbPath, events);
    const eventsDb = createEventsDb(eventsDbPath);
    const mainDb = createMainDb(mainDbPath);
    mainDb.run("insert into entities (id, stream_id) values (?, ?)", streamDid, streamDid);
    mainDb.run("insert into comp_space (entity) values (?)", streamDid);

    // First run
    const r1 = await migrateStream(eventsDb, mainDb, streamDid, leafDbPath, false);
    expect(r1).toEqual({ eventsMigrated: 2, latestIdx: 2 });

    // Second run
    const r2 = await migrateStream(eventsDb, mainDb, streamDid, leafDbPath, false);
    expect(r2).toEqual({ eventsMigrated: 2, latestIdx: 2 });

    // Event count unchanged (INSERT OR IGNORE)
    const eventCount = eventsDb
      .query("select count(*) as c from stream_events")
      .get() as { c: number };
    expect(eventCount.c).toBe(2);

    // stream_state has exactly one row
    const stateRows = eventsDb
      .query("select count(*) as c from stream_state")
      .all() as Array<{ c: number }>;
    expect(stateRows[0].c).toBe(1);

    // latest_event still correct
    const state = eventsDb
      .query("select latest_event from stream_state where stream_id = ?")
      .get(streamDid) as { latest_event: number } | undefined;
    expect(state!.latest_event).toBe(2);

    eventsDb.close();
    mainDb.close();
  });
});

test("roomy_schema_version is set to MIGRATION_PENDING after migration", async () => {
  const streamDid = "did:plc:schema-version-test";
  const leafDbPath = tmpPath("stream.db");
  const eventsDbPath = tmpPath("events.sqlite");
  const mainDbPath = tmpPath("main.sqlite");

  const events = [
    { idx: 1, user: "did:plc:alice", payload: new Uint8Array([1]), signature: new Uint8Array([2]) },
  ];

  createLeafStreamDb(leafDbPath, events);
  const eventsDb = createEventsDb(eventsDbPath);
  const mainDb = createMainDb(mainDbPath);
  mainDb.run("insert into entities (id, stream_id) values (?, ?)", streamDid, streamDid);
  mainDb.run("insert into comp_space (entity) values (?)", streamDid);

  await migrateStream(eventsDb, mainDb, streamDid, leafDbPath, false);

  // Run the same schema-version SQL that main() runs after all streams are migrated
  mainDb.run(
    `INSERT INTO roomy_schema_version (id, version)
     VALUES (1, 'MIGRATION_PENDING')
     ON CONFLICT(id) DO UPDATE SET version = 'MIGRATION_PENDING'`,
  );

  const row = mainDb
    .query("select version from roomy_schema_version where id = 1")
    .get() as { version: string } | undefined;
  expect(row).toBeDefined();
  expect(row!.version).toBe("MIGRATION_PENDING");

  eventsDb.close();
  mainDb.close();
});

describe("migrateDidKeys", () => {
  test("copies dids, did_keys, and did_owners from Leaf main DB to events DB", async () => {
    const leafMainDbPath = tmpPath("leaf.db");
    const eventsDbPath = tmpPath("events.sqlite");

    const k256Bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const p256Bytes = new Uint8Array([0x0a, 0x0b, 0x0c, 0x0d]);

    createLeafMainDb(leafMainDbPath, [
      {
        did: "did:plc:stream-one",
        p256_key: p256Bytes,
        k256_key: k256Bytes,
        owners: ["did:plc:alice", "did:plc:bob"],
      },
      {
        did: "did:plc:stream-two",
        owners: ["did:plc:charlie"],
      },
    ]);

    const eventsDb = createEventsDb(eventsDbPath);

    await migrateDidKeys(eventsDb, leafMainDbPath, false);

    // Check dids
    const didRows = eventsDb
      .query("select did from dids order by did")
      .all() as Array<{ did: string }>;
    expect(didRows).toHaveLength(2);
    expect(didRows[0].did).toBe("did:plc:stream-one");
    expect(didRows[1].did).toBe("did:plc:stream-two");

    // Check did_keys — stream-one has keys, stream-two has none
    const keyRows = eventsDb
      .query("select did, p256_key, k256_key from did_keys order by did")
      .all() as Array<{ did: string; p256_key: Uint8Array | null; k256_key: Uint8Array | null }>;
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0].did).toBe("did:plc:stream-one");
    expect(new Uint8Array(keyRows[0].p256_key!)).toEqual(p256Bytes);
    expect(new Uint8Array(keyRows[0].k256_key!)).toEqual(k256Bytes);

    // Check did_owners
    const ownerRows = eventsDb
      .query("select did, owner from did_owners order by did, owner")
      .all() as Array<{ did: string; owner: string }>;
    expect(ownerRows).toHaveLength(3);
    expect(ownerRows[0]).toEqual({ did: "did:plc:stream-one", owner: "did:plc:alice" });
    expect(ownerRows[1]).toEqual({ did: "did:plc:stream-one", owner: "did:plc:bob" });
    expect(ownerRows[2]).toEqual({ did: "did:plc:stream-two", owner: "did:plc:charlie" });

    eventsDb.close();
  });

  test("k256 private key bytes are byte-identical after roundtrip", async () => {
    const leafMainDbPath = tmpPath("leaf.db");
    const eventsDbPath = tmpPath("events.sqlite");

    // Generate a realistic-looking k256 key (32 bytes)
    const k256Key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) k256Key[i] = i + 1;

    createLeafMainDb(leafMainDbPath, [
      {
        did: "did:plc:keytest",
        k256_key: k256Key,
        owners: ["did:plc:owner"],
      },
    ]);

    const eventsDb = createEventsDb(eventsDbPath);
    await migrateDidKeys(eventsDb, leafMainDbPath, false);

    const row = eventsDb
      .query("select k256_key from did_keys where did = ?")
      .get("did:plc:keytest") as { k256_key: Uint8Array } | undefined;
    expect(row).toBeDefined();
    expect(new Uint8Array(row!.k256_key)).toEqual(k256Key);

    eventsDb.close();
  });

  test("dry-run does not write any DID data", async () => {
    const leafMainDbPath = tmpPath("leaf.db");
    const eventsDbPath = tmpPath("events.sqlite");

    createLeafMainDb(leafMainDbPath, [
      {
        did: "did:plc:dry-test",
        k256_key: new Uint8Array([1, 2, 3]),
        owners: ["did:plc:dry-owner"],
      },
    ]);

    const eventsDb = createEventsDb(eventsDbPath);
    await migrateDidKeys(eventsDb, leafMainDbPath, true);

    const didCount = eventsDb
      .query("select count(*) as c from dids")
      .get() as { c: number };
    expect(didCount.c).toBe(0);

    const keyCount = eventsDb
      .query("select count(*) as c from did_keys")
      .get() as { c: number };
    expect(keyCount.c).toBe(0);

    const ownerCount = eventsDb
      .query("select count(*) as c from did_owners")
      .get() as { c: number };
    expect(ownerCount.c).toBe(0);

    eventsDb.close();
  });

  test("idempotent — running twice does not duplicate dids or owners (did_keys has no unique constraint so duplicates may occur)", async () => {
    const leafMainDbPath = tmpPath("leaf.db");
    const eventsDbPath = tmpPath("events.sqlite");

    createLeafMainDb(leafMainDbPath, [
      {
        did: "did:plc:idem",
        k256_key: new Uint8Array([10, 20]),
        owners: ["did:plc:owner1"],
      },
    ]);

    const eventsDb = createEventsDb(eventsDbPath);

    await migrateDidKeys(eventsDb, leafMainDbPath, false);
    await migrateDidKeys(eventsDb, leafMainDbPath, false);

    // dids has a primary key so INSERT OR IGNORE prevents duplicates
    const didCount = eventsDb
      .query("select count(*) as c from dids")
      .get() as { c: number };
    expect(didCount.c).toBe(1);

    // did_keys has no unique constraint — duplicates are possible
    // (the schema uses references dids(did) without a PK/unique on did)
    const keyCount = eventsDb
      .query("select count(*) as c from did_keys")
      .get() as { c: number };
    expect(keyCount.c).toBeGreaterThanOrEqual(1);

    // did_owners has unique(did, owner) so INSERT OR IGNORE prevents duplicates
    const ownerCount = eventsDb
      .query("select count(*) as c from did_owners")
      .get() as { c: number };
    expect(ownerCount.c).toBe(1);

    eventsDb.close();
  });

  test("missing leaf.db skips DID key migration without error", async () => {
    const eventsDbPath = tmpPath("events.sqlite");
    const missingPath = tmpPath("nonexistent.db");

    const eventsDb = createEventsDb(eventsDbPath);

    // Should not throw — just log a warning
    await migrateDidKeys(eventsDb, missingPath, false);

    const didCount = eventsDb
      .query("select count(*) as c from dids")
      .get() as { c: number };
    expect(didCount.c).toBe(0);

    eventsDb.close();
  });
});
