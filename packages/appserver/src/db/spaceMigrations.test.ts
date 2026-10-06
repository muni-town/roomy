/**
 * In-place per-space migration tests.
 *
 * A per-space schema bump upgrades each space DB in place: the worker applies
 * the version's structural `up`, then the boot runner runs its data task
 * (`db/spaceMigrations.ts`). The blue-green rebuild is only the fallback — for
 * a DB whose version this build cannot start from, or a migration that
 * declines.
 *
 * The observable difference between the two paths is what each leaves behind:
 * an in-place upgrade keeps the DB, so a row no rebuild would produce is still
 * there afterwards; a rebuild replaces the file wholesale, so that row is gone.
 * The tests use that sentinel to prove which path ran, alongside the derived
 * state both paths must agree on.
 *
 * A bump lands on the NEXT boot, so each test materialises a space with one
 * pool, then simulates the deploy by opening a fresh pool over the same files:
 * the worker's per-space handle cache is process-local, and an already-open
 * handle would skip the version check the new pool must take.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { encode } from "@atcute/cbor";
import { parseEvent, type Event, StreamDid, UserDid } from "@roomy-space/sdk";
import { ulid } from "ulidx";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SpaceRematerializingError, StreamManager } from "../streams/StreamManager.ts";
import { fileURLToPath } from "node:url";
import { DatabasePool } from "../db/pool.ts";
import { GLOBAL_SCHEMA_VERSION, SPACE_SCHEMA_VERSION } from "../db/db.ts";
import { READSTATE_SCHEMA_VERSION } from "../db/readStateDb.ts";
import type { DbLike } from "../db/types.ts";
import { reMaterializeFromLocalEvents } from "../streams/reMaterialize.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const ADMIN = UserDid.assert("did:plc:migration-admin");

let dir: string;
let spacesDir: string;
let eventsPath: string;
let pool: DatabasePool | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "roomy-migration-"));
  spacesDir = join(dir, "spaces");
  eventsPath = join(dir, "events.sqlite");
});

afterEach(async () => {
  await pool?.closeGracefully();
  pool = null;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Open a fresh pool over the current files. Calling this after closing the
 * previous one is what a deploy looks like: same DBs on disk, new worker
 * threads with an empty handle cache.
 */
async function openPool(
  readStateDbPath: string = ":memory:",
): Promise<{ pool: DatabasePool; router: DbLike }> {
  const p = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
  await p.init({
    readStateDbPath,
    eventsDbPath: eventsPath,
    globalDbPath: join(dir, "global.sqlite"),
    spacesDir,
    readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
    spaceSchemaVersion: SPACE_SCHEMA_VERSION,
    globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
  });
  // Graceful: the previous workers must have closed their SQLite handles, or
  // this pool's first write to the same files races the OS releasing them.
  await pool?.closeGracefully();
  pool = p;
  return { pool: p, router: p.router() };
}

function parse(raw: Record<string, unknown>): Event {
  const parsed = parseEvent(raw);
  if (!parsed.success) throw new Error(parsed.error);
  return parsed.data;
}

/** Seed a log row for `event`, stamped with a server receipt instant. */
async function seedEvent(
  db: DbLike,
  streamDid: StreamDid,
  event: Event,
  idx: number,
  receivedAt: number,
): Promise<void> {
  await db.run(
    `insert into stream_events (stream_id, idx, user, payload, signature, event_type, created_at, received_at)
     values (?, ?, ?, ?, x'', ?, ?, ?)`,
    streamDid,
    idx,
    ADMIN,
    encode(event as Parameters<typeof encode>[0]),
    event.$type,
    receivedAt,
    receivedAt,
  );
}

/**
 * Materialise a space whose messages carry sender-minted ULID times six hours
 * in the past, so a key derived from the message id (the pre-v3 rule) is
 * distinguishable from one derived from the receipt instant.
 */
async function materialiseSkewedSpace(
  db: DbLike,
  streamDid: StreamDid,
): Promise<{ roomId: string; messageIds: string[] }> {
  const roomId = ulid();
  const skewedAt = Date.now() - 6 * 60 * 60 * 1000;
  await seedEvent(
    db,
    streamDid,
    parse({
      id: roomId,
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.channel",
      name: "general",
    }),
    0,
    Date.now(),
  );
  const messageIds = [ulid(skewedAt), ulid(skewedAt)];
  for (let i = 0; i < messageIds.length; i++) {
    await seedEvent(
      db,
      streamDid,
      parse({
        id: messageIds[i],
        room: roomId,
        $type: "space.roomy.message.createMessage.v0",
        body: {
          mimeType: "text/plain",
          data: { $bytes: Buffer.from(`hi ${i}`).toString("base64") },
        },
        extensions: {},
      }),
      i + 1,
      Date.now(),
    );
  }
  await reMaterializeFromLocalEvents(db, (async () => []) as never, null, 1);
  return { roomId, messageIds };
}

function keysOf(
  db: DbLike,
  streamDid: StreamDid,
): Promise<Array<{ id: string; sort_idx: string | null }>> {
  return db
    .forSpace!(streamDid)
    .query("select id, sort_idx from entities order by id")
    .all<{ id: string; sort_idx: string | null }>();
}

/**
 * Rewrite the space's file as a pre-v3 DB: version 2 (in the manifest, so
 * upgradable), no migration markers, keys carrying the old rule, and a sentinel
 * row that only an in-place upgrade preserves.
 */
function makeItAnOlderSpace(streamDid: StreamDid): void {
  const file = join(spacesDir, `${streamDid}.sqlite`);
  const raw = new Database(file);
  raw.run("update space_schema_version set version = '2' where id = 1");
  raw.run("delete from space_schema_migrations");
  raw.run("update entities set sort_idx = id where sort_idx is not null");
  raw.run(
    "insert into entities (id, stream_id) values ('sentinel-in-place', ?)",
    [streamDid],
  );
  raw.close();
}

describe("in-place per-space migration", () => {
  test("a stale space is upgraded in place, not rebuilt", async () => {
    const streamDid = StreamDid.assert("did:web:migration-inplace.example");
    let router: DbLike;
    ({ router } = await openPool());
    const { messageIds } = await materialiseSkewedSpace(router, streamDid);
    const live = (await keysOf(router, streamDid)).filter(
      (r) => r.sort_idx !== null,
    );
    expect(live).toHaveLength(2);

    makeItAnOlderSpace(streamDid);

    // Deploy: a new pool over the same files must upgrade, not replay.
    ({ router } = await openPool());
    expect((await router.checkSpaceSchema!(streamDid)).current).toBe(false);
    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);

    // The DB was kept: the sentinel a rebuild would have dropped is still here.
    const sentinel = await router
      .forSpace!(streamDid)
      .query("select id from entities where id = 'sentinel-in-place'")
      .get<{ id: string }>();
    expect(sentinel?.id).toBe("sentinel-in-place");

    // The keys are the ones a live write produces, and they follow the receipt
    // instant rather than the skewed sender clock.
    const after = (await keysOf(router, streamDid)).filter(
      (r) => r.sort_idx !== null,
    );
    expect(after.map((r) => r.sort_idx)).toEqual(live.map((r) => r.sort_idx));
    for (const id of messageIds) {
      expect(after.find((r) => r.id === id)?.sort_idx).not.toBe(id);
    }

    // The version advanced and the v3 task is stamped done.
    const spaceDb = router.forSpace!(streamDid);
    const version = await spaceDb
      .query("select version from space_schema_version where id = 1")
      .get<{ version: string }>();
    expect(version?.version).toBe(SPACE_SCHEMA_VERSION);
    const marker = await spaceDb
      .query("select completed_at from space_schema_migrations where version = '3'")
      .get<{ completed_at: number | null }>();
    expect(marker?.completed_at).not.toBeNull();
    expect((await router.checkSpaceSchema!(streamDid)).current).toBe(true);
  });

  test("a reorder in the log makes the migration decline and rebuild", async () => {
    const streamDid = StreamDid.assert("did:web:migration-rebuild.example");
    let router: DbLike;
    ({ router } = await openPool());
    const { roomId, messageIds } = await materialiseSkewedSpace(router, streamDid);
    await seedEvent(
      router,
      streamDid,
      parse({
        id: ulid(),
        room: roomId,
        $type: "space.roomy.message.reorderMessage.v0",
        messageId: messageIds[1]!,
        after: messageIds[0]!,
      }),
      3,
      Date.now(),
    );
    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);

    makeItAnOlderSpace(streamDid);

    ({ router } = await openPool());
    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);

    // The rebuild replaced the DB: the sentinel is gone.
    const sentinel = await router
      .forSpace!(streamDid)
      .query("select id from entities where id = 'sentinel-in-place'")
      .get<{ id: string }>();
    expect(sentinel).toBeNull();

    // ...and the space is current, with every message keyed.
    const spaceDb = router.forSpace!(streamDid);
    const version = await spaceDb
      .query("select version from space_schema_version where id = 1")
      .get<{ version: string }>();
    expect(version?.version).toBe(SPACE_SCHEMA_VERSION);
    const keyed = await spaceDb
      .query(
        "select count(*) as n from entities where room = ? and sort_idx is not null",
      )
      .get<{ n: number }>(roomId);
    expect(keyed!.n).toBe(messageIds.length);
  });

  test("a version this build cannot start from is left untouched for the rebuild", async () => {
    const streamDid = StreamDid.assert("did:web:migration-unknown.example");
    let router: DbLike;
    ({ router } = await openPool());
    await materialiseSkewedSpace(router, streamDid);

    // "0" predates the manifest's first version.
    const raw = new Database(join(spacesDir, `${streamDid}.sqlite`));
    raw.run("update space_schema_version set version = '0' where id = 1");
    raw.close();

    ({ router } = await openPool());
    expect((await router.checkSpaceSchema!(streamDid)).current).toBe(false);

    // Reads still serve the existing rows — the worker never wipes a DB it
    // cannot upgrade, and the pass rebuilds it rather than serving it as-is.
    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);
    const version = await router
      .forSpace!(streamDid)
      .query("select version from space_schema_version where id = 1")
      .get<{ version: string }>();
    expect(version?.version).toBe(SPACE_SCHEMA_VERSION);
  });

  test("a data task left owed by an interrupted pass still runs", async () => {
    const streamDid = StreamDid.assert("did:web:migration-resume.example");
    let router: DbLike;
    ({ router } = await openPool());
    const { messageIds } = await materialiseSkewedSpace(router, streamDid);
    const live = (await keysOf(router, streamDid)).filter(
      (r) => r.sort_idx !== null,
    );

    // A pass that committed the version bump but died before the task: the DB
    // is on the current schema, the marker is still null, and the keys are the
    // old ones.
    const raw = new Database(join(spacesDir, `${streamDid}.sqlite`));
    raw.run("delete from space_schema_migrations");
    raw.run(
      "insert into space_schema_migrations (version, completed_at) values ('3', null)",
    );
    raw.run("update entities set sort_idx = id where sort_idx is not null");
    raw.run(
      "insert into entities (id, stream_id) values ('sentinel-in-place', ?)",
      [streamDid],
    );
    raw.close();

    ({ router } = await openPool());
    // The version is current, so this is not a stale DB — the pending marker is
    // the only signal that work remains.
    expect((await router.checkSpaceSchema!(streamDid)).current).toBe(true);
    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);

    const after = (await keysOf(router, streamDid)).filter(
      (r) => r.sort_idx !== null,
    );
    expect(after.map((r) => r.sort_idx)).toEqual(live.map((r) => r.sort_idx));
    for (const id of messageIds) {
      expect(after.find((r) => r.id === id)?.sort_idx).not.toBe(id);
    }

    const marker = await router
      .forSpace!(streamDid)
      .query("select completed_at from space_schema_migrations where version = '3'")
      .get<{ completed_at: number | null }>();
    expect(marker?.completed_at).not.toBeNull();
  });

  test("the in-place upgrade re-anchors read-state watermarks", async () => {
    const streamDid = StreamDid.assert("did:web:migration-watermark.example");
    const roomId = ulid();
    // A sender clock six hours behind, so the pre-v3 key (the ULID) and the
    // post-v3 key (the receipt) are distinguishable.
    const skewedAt = Date.now() - 6 * 60 * 60 * 1000;
    const messageId = ulid(skewedAt);
    const receivedAt = Date.now();

    const readStatePath = join(dir, "readstate.sqlite");

    let router: DbLike;
    ({ router } = await openPool(readStatePath));
    await seedEvent(
      router,
      streamDid,
      parse({
        id: roomId,
        $type: "space.roomy.room.createRoom.v0",
        kind: "space.roomy.channel",
        name: "general",
      }),
      0,
      receivedAt,
    );
    await seedEvent(
      router,
      streamDid,
      parse({
        id: messageId,
        room: roomId,
        $type: "space.roomy.message.createMessage.v0",
        body: {
          mimeType: "text/plain",
          data: { $bytes: Buffer.from("hi").toString("base64") },
        },
        extensions: {},
      }),
      1,
      receivedAt,
    );
    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);

    // The user's watermark is the message's then-current key: the old rule
    // keyed a replayed message by its own ULID.
    const readState = router.readState!();
    await readState.run(
      `insert into read_positions (user_did, room_id, space_did, seen_up_to, unread_count, updated_at)
       values (?, ?, ?, ?, 0, ?)`,
      ADMIN,
      roomId,
      streamDid,
      messageId,
      receivedAt,
    );

    // Age the space DB so the deploy below takes the in-place upgrade.
    const raw = new Database(join(spacesDir, `${streamDid}.sqlite`));
    raw.run("update space_schema_version set version = '2' where id = 1");
    raw.run("delete from space_schema_migrations");
    raw.run("update entities set sort_idx = id where sort_idx is not null");
    raw.close();

    ({ router } = await openPool(readStatePath));
    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);

    const entityKey = await router
      .forSpace!(streamDid)
      .query("select sort_idx from entities where id = ?")
      .get<{ sort_idx: string }>(messageId);
    const watermark = await router
      .readState!()
      .query("select seen_up_to from read_positions where user_did = ? and room_id = ?")
      .get<{ seen_up_to: string }>(ADMIN, roomId);
    const version = await router
      .forSpace!(streamDid)
      .query("select version from space_schema_version where id = 1")
      .get<{ version: string }>();

    // The upgrade ran in place (not the rebuild fallback)...
    expect(version?.version).toBe(SPACE_SCHEMA_VERSION);
    // ...the message carries its new key, and the persisted watermark names
    // that same key rather than the one it held before the re-key.
    expect(entityKey?.sort_idx).not.toBe(messageId);
    expect(watermark?.seen_up_to).toBe(entityKey?.sort_idx);
  });

  test("a write is rejected while the migration gate is open", async () => {
    const streamDid = StreamDid.assert("did:web:migration-gate.example");
    const { router } = await openPool();
    await materialiseSkewedSpace(router, streamDid);

    const sm = new StreamManager(router, {
      appserverUrl: "https://appserver.example",
      getProfiles: (async () => []) as never,
    });

    // Open the gate the way the upgrade pass does, then assert the space's
    // single write choke point refuses the write before it reaches the log.
    await router.spaceMigrationBegin!(streamDid);
    expect(await router.isSpaceMigrating!(streamDid)).toBe(true);

    const err = await sm
      .sendEvents(
        streamDid,
        [parse({ id: ulid(), $type: "space.roomy.room.createRoom.v0", kind: "space.roomy.channel", name: "mid-migration" })],
        ADMIN,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(SpaceRematerializingError);

    await router.spaceMigrationEnd!(streamDid);
    expect(await router.isSpaceMigrating!(streamDid)).toBe(false);

    // The write did not land, so no room was created.
    const rooms = await router
      .forSpace!(streamDid)
      .query("select count(*) as n from comp_room")
      .get<{ n: number }>();
    expect(rooms!.n).toBe(1);
  });
});
