import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ulid } from "ulidx";
import {
  StreamDid,
  StreamIndex,
  UserDid,
  newUlid,
  type DecodedStreamEvent,
  type Event,
} from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import type { SQLQueryBindings } from "bun:sqlite";

import { toAsyncDb } from "../db/syncAdapter.ts";
import { applyBatch } from "./applyBatch.ts";
import { applyBundle } from "./applyBundle.ts";
import type { StatementBundleSuccess } from "./types.ts";
import { selectMessages } from "../queries/selectMessages.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

const STREAM = StreamDid.assert("did:web:test-stream.example");
const USER = UserDid.assert("did:plc:test-user");

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [SCHEMA_VERSION]);
  return { db, asyncDb: toAsyncDb(db) };
}

function seedSpace(db: Database, streamDid: StreamDid): void {
  // The space entity + comp_space row are normally created by the
  // PersonalJoinSpace materialiser on the user's personal stream. Tests for
  // the apply machinery seed them directly so we can verify backfilled_to.
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    streamDid,
    streamDid,
  ]);
  db.run("insert into comp_space (entity) values (?)", [streamDid]);
}

function decoded(event: Event, idx: number): DecodedStreamEvent {
  return { event, idx: idx as StreamIndex, user: USER };
}

function createRoomEvent(name: string): Event {
  return {
    $type: "space.roomy.room.createRoom.v0",
    id: newUlid(),
    kind: "space.roomy.channel",
    name,
  } as unknown as Event;
}

/** Seed a channel + thread pair so a createRoomLink can reference both. */
function seedChannelAndThread(
  db: Database,
  channelId: string,
  threadId: string,
): void {
  for (const id of [channelId, threadId]) {
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      id,
      STREAM,
    ]);
  }
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [channelId],
  );
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [threadId],
  );
}

/**
 * Build a createRoomLink event linking `threadId` into `channelId`.
 * Mirrors what the SDK's createThread / createRoomLink operations emit.
 */
function createRoomLinkEvent(channelId: string, threadId: string): Event {
  return {
    $type: "space.roomy.link.createRoomLink.v0",
    id: newUlid(),
    room: channelId,
    linkToRoom: threadId,
    isCreationLink: true,
  } as unknown as Event;
}

describe("applyBatch", () => {
  test("applies a single event and advances backfilled_to", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const event = createRoomEvent("general");
    const stats = await applyBatch(asyncDb, STREAM, [decoded(event, 5)], {
      isBackfill: true,
    });

    expect(stats.applied).toBe(1);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    const room = await asyncDb
      .query("select entity, label from comp_room where entity = ?")
      .get<{ entity: string; label: string }>(event.id);
    expect(room?.label).toBe("space.roomy.channel");

    const cursor = await asyncDb
      .query("select backfilled_to from comp_space where entity = ?")
      .get<{ backfilled_to: number }>(STREAM);
    expect(cursor?.backfilled_to).toBe(5);
  })

  test("counts materialiser errors without aborting the batch", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const ok = createRoomEvent("ok");
    const bad = {
      $type: "space.roomy.this.does.not.exist.v0",
      id: newUlid(),
    } as unknown as Event;
    const ok2 = createRoomEvent("ok2");

    const stats = await applyBatch(
      asyncDb,
      STREAM,
      [decoded(ok, 1), decoded(bad, 2), decoded(ok2, 3)],
      { isBackfill: true },
    );

    expect(stats.applied).toBe(2);
    expect(stats.materializerErrors).toBe(1);
    expect(stats.applyErrors).toBe(0);
    expect(stats.failed).toHaveLength(1);
    expect(stats.failed[0]?.reason).toBe("materializer");

    expect(
      (await asyncDb
        .query("select count(*) as count from comp_room")
        .get<{ count: number }>())?.count,
    ).toBe(2);

    // Cursor advances to the highest idx in the batch even though one event
    // failed — the failure is tracked, but we have no reason to stay stuck
    // on a permanently-broken event.
    expect(
      (await asyncDb
        .query("select backfilled_to from comp_space where entity = ?")
        .get<{ backfilled_to: number }>(STREAM))?.backfilled_to,
    ).toBe(3);
  })

  test("backfilled_to never moves backwards", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    await applyBatch(asyncDb, STREAM, [decoded(createRoomEvent("a"), 10)], {
      isBackfill: true,
    });
    await applyBatch(asyncDb, STREAM, [decoded(createRoomEvent("b"), 3)], {
      isBackfill: true,
    });

    const cursor = await asyncDb
      .query("select backfilled_to from comp_space where entity = ?")
      .get<{ backfilled_to: number }>(STREAM);
    expect(cursor?.backfilled_to).toBe(10);
  })

  test("empty batch returns zero stats and does not touch cursor", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);
    db.run("update comp_space set backfilled_to = 7 where entity = ?", [
      STREAM,
    ]);

    const stats = await applyBatch(asyncDb, STREAM, [], { isBackfill: false });

    expect(stats.applied).toBe(0);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    expect(
      (await asyncDb
        .query("select backfilled_to from comp_space where entity = ?")
        .get<{ backfilled_to: number }>(STREAM))?.backfilled_to,
    ).toBe(7);
  })

  test("a single bad SQL error rolls back only that event's savepoint", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const goodA = createRoomEvent("a");
    const goodB = createRoomEvent("b");

    // Drop comp_room mid-batch by hand-applying the first event, then
    // breaking the schema so the second one's INSERT into comp_room fails.
    // We do this via two batches: first batch applies normally, then we
    // break a constraint and fire a second batch.
    await applyBatch(asyncDb, STREAM, [decoded(goodA, 1)], { isBackfill: true });

    // Force a NOT NULL violation by removing comp_room's `entity` column path —
    // simplest deterministic break is a duplicate-pkey: we re-use goodA's id.
    const dup = {
      $type: "space.roomy.room.createRoom.v0",
      id: goodA.id, // same ULID → entities row already exists, comp_room row exists
      kind: "space.roomy.channel",
      name: "dup",
    } as unknown as Event;

    // (this should NOT throw — comp_room insert has `on conflict do nothing`)
    // So we need a different break: violate the default_access CHECK.
    const broken = {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.channel",
      defaultAccess: "bogus", // not in ('readwrite','read','none')
      name: "broken",
    } as unknown as Event;

    const stats = await applyBatch(
      asyncDb,
      STREAM,
      [decoded(dup, 2), decoded(broken, 3), decoded(goodB, 4)],
      { isBackfill: true },
    );

    // dup is a no-op (on conflict do nothing), broken should fail apply,
    // goodB should still apply.
    expect(stats.applyErrors).toBeGreaterThanOrEqual(1);
    expect(stats.applied).toBeGreaterThanOrEqual(1);
    expect(
      (await asyncDb
        .query("select name from comp_info where entity = ?")
        .get<{ name: string | null }>(goodB.id))?.name,
    ).toBe("b");

    // The "broken" event must NOT have left an entities row behind — its
    // savepoint should have rolled back.
    expect(
      (await asyncDb
        .query("select count(*) as count from entities where id = ?")
        .get<{ count: number }>(broken.id))?.count,
    ).toBe(0);
  })

  // Regression: the createRoomLink materialiser computes canonical_parent
  // ("first link wins") from the current edge count. With `insert or replace`
  // it was non-idempotent — re-applying the same event flipped
  // canonical_parent 1 → 0, corrupting the parent-channel link for any
  // thread whose stream got re-backfilled. This re-ran on production data
  // and left ~8% of threads orphaned from their channel.
  test("createRoomLink is idempotent under re-application (canonical_parent stays 1)", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);
    const channelId = newUlid();
    const threadId = newUlid();
    seedChannelAndThread(db, channelId, threadId);

    const link = createRoomLinkEvent(channelId, threadId);

    // First application establishes the link with canonical_parent = 1.
    await applyBatch(asyncDb, STREAM, [decoded(link, 1)], { isBackfill: true });
    const first = await asyncDb
      .query("select payload from edges where label = 'link'")
      .get<{ payload: string }>();
    expect(first?.payload).toBe('{"canonical_parent":1}');

    // Simulate a re-backfill: the same event is delivered and applied again.
    // The materialiser must NOT overwrite the established canonical_parent.
    await applyBatch(asyncDb, STREAM, [decoded(link, 2)], { isBackfill: true });
    await applyBatch(asyncDb, STREAM, [decoded(link, 3)], { isBackfill: true });

    const after = await asyncDb
      .query("select payload from edges where label = 'link'")
      .get<{ payload: string }>();
    expect(after?.payload).toBe('{"canonical_parent":1}');

    // And there is still exactly one link edge (no duplicates).
    const count = (await asyncDb
      .query("select count(*) as n from edges where label = 'link'")
      .get<{ n: number }>())?.n;
    expect(count).toBe(1);
  })
});

/** Build a createMessage event with a text body in the decoded `{ buf }` form. */
function createMessageEvent(roomId: string, id: string, text: string): Event {
  return {
    $type: "space.roomy.message.createMessage.v0",
    id,
    room: roomId,
    body: {
      mimeType: "text/markdown",
      data: { buf: new TextEncoder().encode(text) },
    },
    extensions: {},
  } as unknown as Event;
}

/** Build a forwardMessages event forwarding one original into `threadId`. */
function forwardMessageEvent(
  threadId: string,
  channelId: string,
  id: string,
  originalId: string,
): Event {
  return {
    $type: "space.roomy.message.forwardMessages.v0",
    id,
    room: threadId,
    messageIds: [originalId],
    fromRoomId: channelId,
  } as unknown as Event;
}

describe("forwardMessages sort order", () => {
  // Regression: forward-reference entities got no sort_idx, so selectMessages
  // fell back to ordering by the forward event's own ULID. A thread-creation
  // batch forwards several messages within the same millisecond, so those
  // ULIDs differ only in their random suffixes and the original chronological
  // order of the forwarded messages was scrambled (older forwarded messages
  // could appear after newer ones). The fix copies the original message's
  // sort_idx onto the forward-reference entity.
  test("forwarded messages sort by the original's timestamp, not the forward event's", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const channelId = newUlid();
    const threadId = newUlid();

    // Two originals in the channel: an OLDER one and a NEWER one (2 min apart).
    const T_old = 1_700_000_000_000;
    const T_new = T_old + 120_000;
    const msgOldId = ulid(T_old);
    const msgNewId = ulid(T_new);
    const msgOld = createMessageEvent(channelId, msgOldId, "old msg");
    const msgNew = createMessageEvent(channelId, msgNewId, "new msg");

    // Forward both into the thread. To reproduce the pre-fix scramble
    // deterministically, give the NEWER original's forward an EARLIER forward
    // event id than the OLDER original's forward. Before the fix the forward
    // references sorted by event id, so the newer-original forward would come
    // first (older-after-newer). After the fix they sort by the originals'
    // sort_idx, restoring chronological order.
    const T_fwd = T_new + 120_000;
    const fwdNewId = ulid(T_fwd); // newer original, earlier forward id
    const fwdOldId = ulid(T_fwd + 5_000); // older original, later forward id
    const fwdNew = forwardMessageEvent(threadId, channelId, fwdNewId, msgNewId);
    const fwdOld = forwardMessageEvent(threadId, channelId, fwdOldId, msgOldId);

    await applyBatch(
      asyncDb,
      STREAM,
      [
        decoded(msgOld, 1),
        decoded(msgNew, 2),
        decoded(fwdNew, 3),
        decoded(fwdOld, 4),
      ],
      { isBackfill: true },
    );

    const { messages } = await selectMessages(asyncDb, {
      kind: "room",
      roomId: threadId,
      limit: 100,
      cursor: null,
    });

    // Ascending: the older original's forward first, then the newer's.
    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe(fwdOldId);
    expect(messages[0]?.content).toBe("old msg");
    expect(messages[1]?.id).toBe(fwdNewId);
    expect(messages[1]?.content).toBe("new msg");
  });
})

// ─── Concurrency: applyBundle savepoint serialization ────────────────────

/**
 * Async DB wrapper that yields to the event loop *before* each operation,
 * simulating the AsyncDatabase worker's per-message interleaving. With
 * `toAsyncDb`, operations execute synchronously before the promise resolves,
 * so concurrent `applyBundle` calls never interleave. This wrapper forces
 * interleaving so the savepoint-mutex fix can be verified.
 */
function yieldingAsyncDb(db: Database): DbLike {
  const toBindings = (...params: unknown[]) => params as SQLQueryBindings[];
  const normaliseRowid = (r: number | bigint | undefined) =>
    r === undefined || r === null ? undefined : Number(r);

  return {
    query(sql: string) {
      const stmt = db.query(sql);
      return {
        async all<T>(...params: unknown[]): Promise<T[]> {
          await Promise.resolve();
          return stmt.all(...toBindings(...params)) as T[];
        },
        async get<T>(...params: unknown[]): Promise<T | null> {
          await Promise.resolve();
          return (stmt.get(...toBindings(...params)) ?? null) as T | null;
        },
      };
    },
    async prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        async all<T>(...params: unknown[]): Promise<T[]> {
          await Promise.resolve();
          return stmt.all(...toBindings(...params)) as T[];
        },
        async get<T>(...params: unknown[]): Promise<T | null> {
          await Promise.resolve();
          return (stmt.get(...toBindings(...params)) ?? null) as T | null;
        },
        async run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }> {
          await Promise.resolve();
          const result = stmt.run(...toBindings(...params));
          return { changes: result.changes, lastInsertRowid: normaliseRowid(result.lastInsertRowid) };
        },
      };
    },
    async exec(sql: string): Promise<void> {
      await Promise.resolve();
      db.exec(sql);
    },
    async run(sql: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }> {
      await Promise.resolve();
      const result = (db.run as (...args: unknown[]) => { changes: number; lastInsertRowid?: number | bigint })(sql, ...toBindings(...params));
      return { changes: result.changes, lastInsertRowid: normaliseRowid(result.lastInsertRowid) };
    },
    async transaction<T>(steps: Array<{ type: "query" | "run" | "exec"; sql: string; params?: unknown[] }>): Promise<T> {
      // Simulate worker transaction: yield, then run synchronously
      await Promise.resolve();
      let lastResult: unknown;
      const run = db.transaction(() => {
        for (const step of steps) {
          switch (step.type) {
            case "query":
              lastResult = db.prepare(step.sql).all(...toBindings(...(step.params ?? [])));
              break;
            case "run":
              lastResult = (db.run as (...args: unknown[]) => { changes: number; lastInsertRowid?: number | bigint })(step.sql, ...toBindings(...(step.params ?? [])));
              break;
            case "exec":
              db.exec(step.sql);
              lastResult = undefined;
              break;
          }
        }
      });
      run();
      return lastResult as T;
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}

describe("applyBundle concurrency", () => {
  test("concurrent applyBundle calls do not destroy each other's savepoints", async () => {
    const { db } = freshDb();
    seedSpace(db, STREAM);

    // Seed a channel room so createMessage events can reference it.
    const channelId = newUlid();
    db.run("insert into entities (id, stream_id) values (?, ?)", [channelId, STREAM]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [channelId],
    );

    const asyncDb = yieldingAsyncDb(db);

    // Two createMessage events with distinct ULIDs — each gets its own
    // savepoint name in applyBundle.
    const eventA = createMessageEvent(channelId, newUlid(), "message A");
    const eventB = createMessageEvent(channelId, newUlid(), "message B");

    // First, materialize the events (insert entities + comp_message rows)
    // so applyBundle's side-effects can find them. We use applyBatch with
    // the synchronous adapter for this setup step.
    const syncDb = toAsyncDb(db);
    await applyBatch(syncDb, STREAM, [decoded(eventA, 1)], { isBackfill: true });
    await applyBatch(syncDb, STREAM, [decoded(eventB, 2)], { isBackfill: true });

    // Now fire two applyBundle calls concurrently with the yielding adapter.
    // Without the mutex, their SAVEPOINT/RELEASE operations interleave:
    // A creates evt_AAA (starts implicit transaction), B creates evt_BBB
    // (nested), A releases evt_AAA (commits, destroys evt_BBB), B fails
    // with "no such savepoint: evt_BBB".
    const bundleA: StatementBundleSuccess = {
      status: "success",
      event: eventA,
      eventIdx: 1 as StreamIndex,
      user: USER,
      statements: [],
      dependsOn: [],
    };
    const bundleB: StatementBundleSuccess = {
      status: "success",
      event: eventB,
      eventIdx: 2 as StreamIndex,
      user: USER,
      statements: [],
      dependsOn: [],
    };

    const results = await Promise.allSettled([
      applyBundle(asyncDb, bundleA, { isBackfill: true, streamId: STREAM }),
      applyBundle(asyncDb, bundleB, { isBackfill: true, streamId: STREAM }),
    ]);

    // Both must succeed — no "no such savepoint" errors.
    for (const [i, result] of results.entries()) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "rejected") {
        // Provide a clear failure message with the actual error.
        throw new Error(`applyBundle ${i} failed: ${result.reason}`);
      }
    }
  });
});
