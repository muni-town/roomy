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
import {
  SpaceRematerializingError,
  StreamManager,
} from "../streams/StreamManager.ts";
import { fileURLToPath } from "node:url";
import { DatabasePool } from "../db/pool.ts";
import { GLOBAL_SCHEMA_VERSION, SPACE_SCHEMA_VERSION } from "../db/db.ts";
import { READSTATE_SCHEMA_VERSION } from "../db/readStateDb.ts";
import type { DbLike } from "../db/types.ts";
import { reMaterializeFromLocalEvents } from "../streams/reMaterialize.ts";
import { orderKey } from "../materialization/sortIdx.ts";

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

/**
 * Materialise a space whose only event is an `updateSpaceInfo`, which
 * materialises a `comp_space` row — the row the DNS handle is stored on before
 * v4.
 */
async function seedSpaceWithCompSpaceRow(
  db: DbLike,
  streamDid: StreamDid,
): Promise<void> {
  await seedEvent(
    db,
    streamDid,
    parse({
      id: ulid(),
      $type: "space.roomy.space.updateSpaceInfo.v0",
      name: "Handled",
    }),
    0,
    Date.now(),
  );
  await reMaterializeFromLocalEvents(db, (async () => []) as never, null, 1);
}

function keysOf(
  db: DbLike,
  streamDid: StreamDid,
): Promise<Array<{ id: string; sort_idx: string | null }>> {
  return db.forSpace!(streamDid)
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
    await reMaterializeFromLocalEvents(
      router,
      (async () => []) as never,
      null,
      1,
    );

    // The DB was kept: the sentinel a rebuild would have dropped is still here.
    const sentinel = await router.forSpace!(streamDid)
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
      .query(
        "select completed_at from space_schema_migrations where version = '3'",
      )
      .get<{ completed_at: number | null }>();
    expect(marker?.completed_at).not.toBeNull();
    expect((await router.checkSpaceSchema!(streamDid)).current).toBe(true);
  });

  test("a reorder in the log makes the migration decline and rebuild", async () => {
    const streamDid = StreamDid.assert("did:web:migration-rebuild.example");
    let router: DbLike;
    ({ router } = await openPool());
    const { roomId, messageIds } = await materialiseSkewedSpace(
      router,
      streamDid,
    );
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
    await reMaterializeFromLocalEvents(
      router,
      (async () => []) as never,
      null,
      1,
    );

    makeItAnOlderSpace(streamDid);

    ({ router } = await openPool());
    await reMaterializeFromLocalEvents(
      router,
      (async () => []) as never,
      null,
      1,
    );

    // The rebuild replaced the DB: the sentinel is gone.
    const sentinel = await router.forSpace!(streamDid)
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
    await reMaterializeFromLocalEvents(
      router,
      (async () => []) as never,
      null,
      1,
    );
    const version = await router.forSpace!(streamDid)
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
    await reMaterializeFromLocalEvents(
      router,
      (async () => []) as never,
      null,
      1,
    );

    const after = (await keysOf(router, streamDid)).filter(
      (r) => r.sort_idx !== null,
    );
    expect(after.map((r) => r.sort_idx)).toEqual(live.map((r) => r.sort_idx));
    for (const id of messageIds) {
      expect(after.find((r) => r.id === id)?.sort_idx).not.toBe(id);
    }

    const marker = await router.forSpace!(streamDid)
      .query(
        "select completed_at from space_schema_migrations where version = '3'",
      )
      .get<{ completed_at: number | null }>();
    expect(marker?.completed_at).not.toBeNull();
  });

  test("a stream whose reads time out does not hold up the in-place upgrade", async () => {
    // The pass walks thousands of streams with one DB request in flight at a
    // time, and every request carries a 30s budget. A request that exceeds it
    // rejects, and before the retry that rejection ended the whole pass: every
    // per-space upgrade behind the slow stream was never attempted, so a
    // schema bump landed with no space re-keyed and every boot repeated the
    // same abort.
    //
    // The timing-out stream here is the first row of the sweep, so every other
    // stream's partitioning runs behind it. Its reads reject the way a real
    // timeout does, and the pass must outlast the rejection to upgrade the
    // stale space.
    const streamDid = StreamDid.assert("did:web:migration-wedged.example");
    const slow = StreamDid.assert("did:aaa:migration-wedged-slow.example");

    let router: DbLike;
    ({ router } = await openPool());
    const { messageIds } = await materialiseSkewedSpace(router, streamDid);
    await seedEvent(
      router,
      slow,
      parse({
        id: ulid(),
        room: ulid(),
        $type: "space.roomy.message.createMessage.v0",
        body: {
          mimeType: "text/plain",
          data: { $bytes: Buffer.from("wedged").toString("base64") },
        },
        extensions: {},
      }),
      0,
      Date.now(),
    );
    await reMaterializeFromLocalEvents(
      router,
      (async () => []) as never,
      null,
      1,
    );
    const live = (await keysOf(router, streamDid)).filter(
      (r) => r.sort_idx !== null,
    );

    makeItAnOlderSpace(streamDid);

    ({ router } = await openPool());
    const forSpace = router.forSpace!.bind(router);
    router.forSpace = (did: string) => {
      const handle = forSpace(did);
      if (did !== slow) return handle;
      return new Proxy(handle, {
        get: (target, prop, receiver) => {
          if (prop !== "query") return Reflect.get(target, prop, receiver);
          return (sql: string) =>
            new Proxy(target.query(sql), {
              get: (stmt, stmtProp, stmtReceiver) => {
                if (stmtProp !== "get") {
                  return Reflect.get(stmt, stmtProp, stmtReceiver);
                }
                return () =>
                  Promise.reject(new Error("Request timed out: query"));
              },
            });
        },
      }) as DbLike;
    };

    await reMaterializeFromLocalEvents(
      router,
      (async () => []) as never,
      null,
      1,
      { streamStep: { attempts: 2, backoffMs: 0 } },
    );

    // The stale space was upgraded in place and re-keyed: the sentinel a
    // rebuild would have dropped is still here, and the keys follow the
    // receipt instant rather than the message ids the pre-v3 rule wrote.
    const sentinel = await router.forSpace!(streamDid)
      .query("select id from entities where id = 'sentinel-in-place'")
      .get<{ id: string }>();
    expect(sentinel?.id).toBe("sentinel-in-place");
    const after = (await keysOf(router, streamDid)).filter(
      (r) => r.sort_idx !== null,
    );
    expect(after.map((r) => r.sort_idx)).toEqual(live.map((r) => r.sort_idx));
    for (const id of messageIds) {
      expect(after.find((r) => r.id === id)?.sort_idx).not.toBe(id);
    }
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
    await reMaterializeFromLocalEvents(
      router,
      (async () => []) as never,
      null,
      1,
    );

    // The user's watermark is the message's then-current key, which no rebuild
    // reproduces: a live createMessage was keyed by the arrival clock, and a
    // replayed one by the event's own ULID, each with a random suffix. Model
    // that by keying the row the way the pre-v3 replay did and storing that
    // value, rather than the message id the old handler never wrote.
    const legacyKey = ulid(skewedAt);

    // Age the space DB so the deploy below takes the in-place upgrade.
    const raw = new Database(join(spacesDir, `${streamDid}.sqlite`));
    raw.run("update space_schema_version set version = '2' where id = 1");
    raw.run("delete from space_schema_migrations");
    raw.run("update entities set sort_idx = ? where id = ?", [
      legacyKey,
      messageId,
    ]);
    raw.close();

    const readState = router.readState!();
    await readState.run(
      `insert into read_positions (user_did, room_id, space_did, seen_up_to, unread_count, updated_at)
       values (?, ?, ?, ?, 0, ?)`,
      ADMIN,
      roomId,
      streamDid,
      legacyKey,
      receivedAt,
    );

    ({ router } = await openPool(readStatePath));
    await reMaterializeFromLocalEvents(
      router,
      (async () => []) as never,
      null,
      1,
    );

    const entityKey = await router.forSpace!(streamDid)
      .query("select sort_idx from entities where id = ?")
      .get<{ sort_idx: string }>(messageId);
    const watermark = await router.readState!()
      .query(
        "select seen_up_to from read_positions where user_did = ? and room_id = ?",
      )
      .get<{ seen_up_to: string }>(ADMIN, roomId);
    const version = await router.forSpace!(streamDid)
      .query("select version from space_schema_version where id = 1")
      .get<{ version: string }>();

    // The upgrade ran in place (not the rebuild fallback)...
    expect(version?.version).toBe(SPACE_SCHEMA_VERSION);
    // ...the message carries its new key, and the persisted watermark names
    // that same key rather than the one it held before the re-key.
    expect(entityKey?.sort_idx).not.toBe(messageId);
    expect(watermark?.seen_up_to).toBe(entityKey?.sort_idx);

    // Which is what the read path measures against: the room is read up to
    // that message. A watermark left on the old key names no entity, so this
    // count returns every message in the room instead.
    const after = await router.forSpace!(streamDid)
      .query(
        "select count(*) as n from entities where room = ? and sort_idx > ?",
      )
      .get<{ n: number }>(roomId, watermark!.seen_up_to);
    expect(after!.n).toBe(0);
  });

  test("the boot pass re-anchors a watermark the upgrade could not follow", async () => {
    // The residue the in-place upgrade leaves: a watermark that names no key
    // and that `sort_idx_prev` had no row for, so the re-anchor had nothing to
    // follow it through. The boot sweep re-derives the anchor from the keys the
    // room holds now, long after the snapshot table is gone.
    const streamDid = StreamDid.assert("did:web:migration-residue.example");
    const { router } = await openPool(join(dir, "readstate-residue.sqlite"));
    const roomId = ulid();
    const receivedAt = Date.now();
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
    // Two messages an hour apart, so the room holds keys on both sides of the
    // watermark below.
    const messageIds = [ulid(receivedAt), ulid(receivedAt + 3_600_000)];
    for (let i = 0; i < messageIds.length; i++) {
      await seedEvent(
        router,
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
        receivedAt + i * 3_600_000,
      );
    }
    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);

    const keys = await router.forSpace!(streamDid)
      .query("select id, sort_idx from entities where room = ? order by sort_idx")
      .all<{ id: string; sort_idx: string }>(roomId);
    expect(keys).toHaveLength(2);

    // Half an hour past the first message: names no key, and sits below the
    // second. The honest anchor is the first message — the last one the user
    // could have seen.
    const orphan = orderKey(receivedAt + 1_800_000, 0);
    await router.readState!().run(
      `insert into read_positions (user_did, room_id, space_did, seen_up_to, unread_count, updated_at)
       values (?, ?, ?, ?, 99, ?)`,
      [ADMIN, roomId, streamDid, orphan, receivedAt],
    );

    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);

    const watermark = await router.readState!()
      .query(
        "select seen_up_to, unread_count from read_positions where user_did = ? and room_id = ?",
      )
      .get<{ seen_up_to: string; unread_count: number }>(ADMIN, roomId);
    // Anchored to the earlier message's key, with the count recomputed from
    // that anchor rather than carried over from the stale row.
    expect(watermark?.seen_up_to).toBe(keys[0]!.sort_idx);
    expect(watermark?.seen_up_to).not.toBe(orphan);

    // Which is what the read path measures against: the room's unread count now
    // equals the messages the timeline shows after the anchor.
    const after = await router.forSpace!(streamDid)
      .query("select count(*) as n from entities where room = ? and sort_idx > ?")
      .get<{ n: number }>(roomId, watermark!.seen_up_to);
    expect(after!.n).toBe(1);
    expect(watermark!.unread_count).toBe(after!.n);
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
        [
          parse({
            id: ulid(),
            $type: "space.roomy.room.createRoom.v0",
            kind: "space.roomy.channel",
            name: "mid-migration",
          }),
        ],
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
    const rooms = await router.forSpace!(streamDid)
      .query("select count(*) as n from comp_room")
      .get<{ n: number }>();
    expect(rooms!.n).toBe(1);
  });

  test("v4 moves a space's DNS handle into the global store", async () => {
    // The DNS handle is assigned by the space's PDS/DNS and never written by an
    // event, so it is not a projection of the log. It moved out of the
    // per-space `comp_space` into the global `space_handles` store, which is
    // what makes a space rebuilt from the log keep it.
    const streamDid = StreamDid.assert("did:web:migration-handle.example");
    let router: DbLike;
    ({ router } = await openPool());
    await seedSpaceWithCompSpaceRow(router, streamDid);

    // Reshape the DB into what a pre-v4 deployment left behind.
    const raw = new Database(join(spacesDir, `${streamDid}.sqlite`));
    raw.run("alter table comp_space add column handle text");
    raw.run("update comp_space set handle = ? where entity = ?", [
      "handled.example",
      streamDid,
    ]);
    raw.run("update space_schema_version set version = '3' where id = 1");
    raw.run("delete from space_schema_migrations");
    raw.close();

    // Deploy: a fresh pool over the same files upgrades the space in place.
    ({ router } = await openPool());
    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);

    expect(
      await router.global!()
        .query("select handle from space_handles where space_did = ?")
        .get<{ handle: string }>(streamDid),
    ).toEqual({ handle: "handled.example" });

    // The per-space column is gone, so a second writer cannot reappear.
    const columns = await router.forSpace!(streamDid)
      .query("select name from pragma_table_info('comp_space')")
      .all<{ name: string }>();
    expect(columns.map((c) => c.name)).not.toContain("handle");

    // A later rebuild of the space leaves the handle alone: it is global state
    // now, not something the replay derives.
    const stale = new Database(join(spacesDir, `${streamDid}.sqlite`));
    stale.run("update space_schema_version set version = '0' where id = 1");
    stale.close();
    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);

    expect(
      await router.global!()
        .query("select handle from space_handles where space_did = ?")
        .get<{ handle: string }>(streamDid),
    ).toEqual({ handle: "handled.example" });
  });

  test("a rebuild carries the handle across before the swap", async () => {
    // A space that reaches the rebuild path without the v4 task having run —
    // a version this build cannot start from — must not lose its handle with
    // the old file.
    const streamDid = StreamDid.assert("did:web:migration-handle-rebuild.example");
    let router: DbLike;
    ({ router } = await openPool());
    await seedSpaceWithCompSpaceRow(router, streamDid);

    const raw = new Database(join(spacesDir, `${streamDid}.sqlite`));
    raw.run("alter table comp_space add column handle text");
    raw.run("update comp_space set handle = ? where entity = ?", [
      "rebuilt.example",
      streamDid,
    ]);
    // "0" predates the manifest, so the upgrade path declines and the space is
    // re-derived into a fresh DB instead.
    raw.run("update space_schema_version set version = '0' where id = 1");
    raw.close();

    ({ router } = await openPool());
    await reMaterializeFromLocalEvents(router, (async () => []) as never, null, 1);

    expect(
      await router.global!()
        .query("select handle from space_handles where space_did = ?")
        .get<{ handle: string }>(streamDid),
    ).toEqual({ handle: "rebuilt.example" });
  });
});
