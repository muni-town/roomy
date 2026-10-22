/**
 * Read-state watermark repair tests.
 *
 * The fixture is the shape the repair exists for: a space whose message keys
 * were re-derived (a v3 re-key, or any rebuild) while a user's stored watermark
 * still holds a value nothing carries, plus the healthy counterpart where the
 * watermark names a live key and must be left alone.
 *
 * The space DB and the read-state DB are two in-memory SQLite files behind one
 * `DbLike`, which is what the router is in production; `forSpace` and
 * `readState` are the seams a sync adapter would otherwise be missing.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "./syncAdapter.ts";
import type { DbLike } from "./types.ts";
import { sweepReadStateWatermarks, watermarksUnresolved } from "./readStateWatermarks.ts";
import { _setLokiSink } from "../log.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SPACE_SCHEMA = readFileSync(join(THIS_DIR, "schema-space.sql"), "utf8");
const READSTATE_SCHEMA = readFileSync(join(THIS_DIR, "readStateSchema.sql"), "utf8");

const SPACE = "did:web:watermarks.example";
const ROOM = "01ROOMWATERMARK0000000000";
const USER = "did:plc:watermark-reader";
/** A key that no entity carries — the state the repair exists for. */
const STALE = "01STALEWATERMARK0000000000";

/** Build the router-shaped fixture: one space DB, one read-state DB. */
function fixture() {
  const spaceRaw = new Database(":memory:");
  spaceRaw.exec("pragma foreign_keys = on");
  spaceRaw.exec(SPACE_SCHEMA);
  const readStateRaw = new Database(":memory:");
  readStateRaw.exec("pragma foreign_keys = on");
  readStateRaw.exec(READSTATE_SCHEMA);
  // The room→space index `openSpaceDbForEntity` resolves through, which the
  // pass falls back to for a row that carries no `space_did` of its own.
  const globalRaw = new Database(":memory:");
  globalRaw.exec("create table entity_space (entity_id text primary key, space_did text not null) strict");

  const space = toAsyncDb(spaceRaw);
  const readState = toAsyncDb(readStateRaw);
  const global = toAsyncDb(globalRaw);
  const router: DbLike = Object.assign(toAsyncDb(spaceRaw), {
    forSpace: () => space,
    readState: () => readState,
    global: () => global,
  });
  return { spaceRaw, readStateRaw, globalRaw, router };
}

/** The room's keys, plus a message with no key at all (a page edit, say). */
function seedRoom(spaceRaw: Database, keys: readonly string[]) {
  const insert = spaceRaw.prepare(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
  );
  insert.run(ROOM, SPACE, null, null);
  for (const key of keys) insert.run(`01MSG${key}`, SPACE, ROOM, key);
  // A row in the room the materialiser never keyed. `updateSeen` and the
  // repair both compare `sort_idx`, so this row is on neither side of the
  // count and must not move the anchor or the recomputed count.
  insert.run("01UNKEYEDMESSAGE000000000", SPACE, ROOM, null);
}

function seedWatermark(
  readStateRaw: Database,
  seenUpTo: string,
  opts: { roomId?: string; spaceDid?: string } = {},
) {
  readStateRaw.run(
    `insert into read_positions (user_did, room_id, space_did, seen_up_to, updated_at)
     values (?, ?, ?, ?, ?)`,
    [USER, opts.roomId ?? ROOM, opts.spaceDid ?? SPACE, seenUpTo, 0],
  );
}

function watermark(readStateRaw: Database, roomId: string = ROOM) {
  return readStateRaw
    .query<
      { seen_up_to: string; updated_at: number },
      [string, string]
    >(
      "select seen_up_to, updated_at from read_positions where user_did = ? and room_id = ?",
    )
    .get(USER, roomId);
}

/**
 * Capture the records a sweep emits, through the logger's own Loki sink — the
 * same record the deployed fleet ships, so a line asserted here is the line an
 * operator would read. The level is raised to `debug` for the duration, because
 * a record below the threshold is dropped before either sink sees it;
 * `restore()` puts the level back so no test leaks state into the next.
 */
function captureLogs() {
  const lines: string[] = [];
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  _setLokiSink({
    push: (r) => lines.push(r.line),
    flush: async () => {},
    stop: () => {},
    stats: () => ({ queued: 0, sent: 0, dropped: 0, failed: 0 }),
  });
  const messagesAt = (level: string): string =>
    lines
      .filter((l) => l.includes(`"level":"${level}"`))
      .map((l) => JSON.parse(l).msg as string)
      .join("\n");
  return {
    debug: () => messagesAt("debug"),
    info: () => messagesAt("info"),
    warn: () => messagesAt("warn"),
    restore: () => {
      _setLokiSink(null);
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    },
  };
}

describe("read-state watermark repair", () => {
  test("re-anchors an unresolved watermark to the last key its room holds", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    seedRoom(spaceRaw, [
      "01A00000000000000000000000",
      "01B00000000000000000000000",
      "01C00000000000000000000000",
      "01D00000000000000000000000",
    ]);
    const stale = "01C50000000000000000000000";
    seedWatermark(readStateRaw, stale);

    const result = await sweepReadStateWatermarks(router, [SPACE]);

    expect(result.examined).toBe(1);
    expect(result.found).toBe(1);
    expect(result.repaired).toBe(1);
    expect(result.unanchorable).toBe(0);
    // Anchored to the greatest key at or below the watermark — the last message
    // the user could have seen — not to the newest message in the room.
    expect(watermark(readStateRaw)?.seen_up_to).toBe("01C00000000000000000000000");
  });

  test("is idempotent: a second pass changes nothing", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    seedRoom(spaceRaw, ["01A00000000000000000000000", "01B00000000000000000000000"]);
    seedWatermark(readStateRaw, "01A50000000000000000000000");

    const first = await sweepReadStateWatermarks(router, [SPACE]);
    expect(first.repaired).toBe(1);
    const after = watermark(readStateRaw);
    expect(after?.seen_up_to).toBe("01A00000000000000000000000");

    const second = await sweepReadStateWatermarks(router, [SPACE]);

    // The repaired value IS a key, so the second pass resolves it to itself:
    // nothing found, nothing written, and the row is byte-identical.
    expect(second.found).toBe(0);
    expect(second.repaired).toBe(0);
    expect(second.unanchorable).toBe(0);
    expect(watermark(readStateRaw)?.seen_up_to).toBe(after?.seen_up_to);
    // Not merely the same value: the row was not written at all. A repair that
    // re-ran would refresh `updated_at` even though every field matched.
    expect(watermark(readStateRaw)?.updated_at).toBe(after?.updated_at);
  });

  test("leaves a watermark naming a live key alone", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    seedRoom(spaceRaw, ["01A00000000000000000000000", "01B00000000000000000000000"]);
    // The live key, with a count the user's own updateSeen wrote.
    seedWatermark(readStateRaw, "01B00000000000000000000000");

    const result = await sweepReadStateWatermarks(router, [SPACE]);

    expect(result.found).toBe(0);
    expect(result.repaired).toBe(0);
    // Untouched: this pass repairs markers, it does not re-derive unread for
    // rows that were never its business.
    expect(watermark(readStateRaw)?.seen_up_to).toBe("01B00000000000000000000000");
    expect(watermark(readStateRaw)?.updated_at).toBe(0);
  });

  test("counts a watermark older than every key its room holds as unresolved", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    seedRoom(spaceRaw, ["01B00000000000000000000000"]);
    // Older than the room's only key: the message it named was deleted, so
    // there is no honest anchor. Left alone and counted, not reset.
    seedWatermark(readStateRaw, "01A00000000000000000000000");

    const result = await sweepReadStateWatermarks(router, [SPACE]);

    expect(result.found).toBe(1);
    expect(result.repaired).toBe(0);
    expect(result.unanchorable).toBe(1);
    expect(watermark(readStateRaw)?.seen_up_to).toBe("01A00000000000000000000000");
  });

  test("a room with no keys left cannot anchor its watermark", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    spaceRaw.run(
      "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, null)",
      ["01EMPTYROOM000000000000000", SPACE, ROOM],
    );
    seedWatermark(readStateRaw, STALE);

    const result = await sweepReadStateWatermarks(router, [SPACE]);

    expect(result.found).toBe(1);
    expect(result.unanchorable).toBe(1);
    expect(watermark(readStateRaw)?.seen_up_to).toBe(STALE);
  });

  test("publishes the residue before repairing it", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    seedRoom(spaceRaw, ["01A00000000000000000000000"]);
    // A row that cannot be anchored at all, so the fleet figure stays non-zero
    // and the pre-repair gauge value is distinguishable from the post-repair one.
    seedWatermark(readStateRaw, "01900000000000000000000000");
    const found = new Map<string, number[]>();
    // The gauge publishes twice: the measured residue, then what is left. The
    // first write is the figure a scrape during the pass reads.
    const realSet = watermarksUnresolved.set.bind(watermarksUnresolved);
    watermarksUnresolved.set = (labels, value) => {
      const seen = found.get("values") ?? [];
      seen.push(value);
      found.set("values", seen);
      realSet(labels, value);
    };
    try {
      await sweepReadStateWatermarks(router, [SPACE]);
    } finally {
      watermarksUnresolved.set = realSet;
    }
    expect(found.get("values")?.slice(0, 2)).toEqual([1, 1]);
  });

  test("counts watermarks it cannot attribute to a space it can read", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    seedRoom(spaceRaw, ["01A00000000000000000000000"]);
    seedWatermark(readStateRaw, STALE);
    // Written before `space_did` was populated. A per-space pass cannot reach
    // it, so it is reported separately rather than dropped from the figure.
    seedWatermark(readStateRaw, STALE, {
      roomId: "01ORPHANROOM000000000000",
      spaceDid: "",
    });

    const result = await sweepReadStateWatermarks(router, [SPACE]);

    expect(result.examined).toBe(1);
    expect(result.unattributed).toBe(1);
    expect(result.found).toBe(1);
    expect(result.repaired).toBe(1);
  });

  test("attributes a row with no space of its own through the global room index", async () => {
    const { spaceRaw, readStateRaw, globalRaw, router } = fixture();
    seedRoom(spaceRaw, ["01A00000000000000000000000"]);
    // What a user's own `updateSeen` writes: the read path never populates
    // `space_did`, so the row carries an empty one and no per-space pass can
    // reach it. The global index says which space the room belongs to.
    seedWatermark(readStateRaw, STALE, { spaceDid: "" });
    globalRaw.run("insert into entity_space (entity_id, space_did) values (?, ?)", [
      ROOM,
      SPACE,
    ]);

    const result = await sweepReadStateWatermarks(router, [SPACE]);

    expect(result.unattributed).toBe(0);
    expect(result.found).toBe(1);
    expect(result.repaired).toBe(1);
    expect(watermark(readStateRaw)?.seen_up_to).toBe("01A00000000000000000000000");
  });

  test("counts a row the index cannot attribute as unattributed", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    seedRoom(spaceRaw, ["01A00000000000000000000000"]);
    // The room belongs to no space in this sweep — a room id from another
    // deployment, or one whose stream no longer exists. Reported on its own so
    // the residue cannot look smaller than it is.
    seedWatermark(readStateRaw, STALE, { spaceDid: "", roomId: "01UNKNOWNROOM00000000000" });

    const result = await sweepReadStateWatermarks(router, [SPACE]);

    expect(result.examined).toBe(0);
    expect(result.unattributed).toBe(1);
    expect(result.found).toBe(0);
  });

  test("is a no-op on an adapter with no read-state or per-space seam", async () => {
    const { spaceRaw, readStateRaw } = fixture();
    seedRoom(spaceRaw, ["01A00000000000000000000000"]);
    seedWatermark(readStateRaw, STALE);
    // A plain sync adapter: the seams are absent, so there is nothing to
    // re-anchor and no throw.
    const plain = toAsyncDb(spaceRaw);

    const result = await sweepReadStateWatermarks(plain, [SPACE]);

    expect(result).toEqual({
      examined: 0,
      found: 0,
      repaired: 0,
      unanchorable: 0,
      unattributed: 0,
      failedSpaces: 0,
    });
    expect(watermark(readStateRaw)?.seen_up_to).toBe(STALE);
  });

  test("a space that cannot be read is reported and does not stop the pass", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    seedRoom(spaceRaw, ["01A00000000000000000000000"]);
    seedWatermark(readStateRaw, STALE);

    const other = "did:web:watermarks-other.example";
    const otherSpace = new Database(":memory:");
    otherSpace.exec("pragma foreign_keys = on");
    otherSpace.exec(SPACE_SCHEMA);
    seedWatermark(readStateRaw, STALE, { roomId: "01OTHERROOM000000000000", spaceDid: other });

    const forSpace = router.forSpace!;
    router.forSpace = (did: string) => {
      if (did !== other) return forSpace(did);
      throw new Error("space DB unavailable");
    };

    const result = await sweepReadStateWatermarks(router, [SPACE, other]);

    expect(result.failedSpaces).toBe(1);
    // The readable space was still repaired.
    expect(result.repaired).toBe(1);
    expect(watermark(readStateRaw)?.seen_up_to).toBe("01A00000000000000000000000");
  });

  test("keeps rows for other users and rooms in the same space independent", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    const otherRoom = "01ROOMTWO0000000000000000";
    seedRoom(spaceRaw, ["01A00000000000000000000000", "01B00000000000000000000000"]);
    spaceRaw.run(
      "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
      ["01MSGTWO000000000000000000", SPACE, otherRoom, "01F00000000000000000000000"],
    );
    // Each user's watermark resolves against its own room's keys.
    seedWatermark(readStateRaw, "01A50000000000000000000000");
    readStateRaw.run(
      `insert into read_positions (user_did, room_id, space_did, seen_up_to, updated_at)
       values (?, ?, ?, ?, 0)`,
      ["did:plc:other-reader", ROOM, SPACE, "01B50000000000000000000000"],
    );

    const result = await sweepReadStateWatermarks(router, [SPACE]);

    expect(result.repaired).toBe(2);
    expect(watermark(readStateRaw)?.seen_up_to).toBe("01A00000000000000000000000");
    expect(
      readStateRaw
        .query<{ seen_up_to: string }, []>(
          "select seen_up_to from read_positions where user_did = 'did:plc:other-reader'",
        )
        .get()?.seen_up_to,
    ).toBe("01B00000000000000000000000");
  });

  test("re-anchors a rebuild's watermarks onto the keys the rebuild produced", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    // A room rebuilt from the log: every message carries a `sort_idx` derived
    // from the log's receipt time, and a message the materialiser never keyed
    // (a thread, a room) carries none.
    const keys = ["01J0000000000000000000000A", "01J0000000000000000000000B"];
    seedRoom(spaceRaw, keys);
    // Watermarks as they stood before the rebuild: they name the pre-rekey keys,
    // which no entity in the rebuilt room carries. This is the state a fleet
    // whose re-key failed holds — the snapshot that could have followed the key
    // is gone, and only the room's current keys can answer.
    seedWatermark(readStateRaw, "01KZZZZZZZZZZZZZZZZZZZZZZ");
    readStateRaw.run(
      `insert into read_positions (user_did, room_id, space_did, seen_up_to, updated_at)
       values (?, ?, ?, ?, 0)`,
      ["did:plc:other-reader", ROOM, SPACE, "01J0000000000000000000000C"],
    );

    const result = await sweepReadStateWatermarks(router, [SPACE]);

    expect(result.found).toBe(2);
    // Both land on the greatest key at or below them in the rebuilt room, and
    // what the gauge publishes is the count that could not move.
    expect(result.repaired).toBe(2);
    expect(result.unanchorable).toBe(0);
    expect(watermark(readStateRaw)?.seen_up_to).toBe(keys[1]);
    expect(
      readStateRaw
        .query<{ seen_up_to: string }, []>(
          "select seen_up_to from read_positions where user_did = 'did:plc:other-reader'",
        )
        .get()?.seen_up_to,
    ).toBe(keys[1]);
  });

  test("reports a space whose watermarks moved on the per-space debug line", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    seedRoom(spaceRaw, ["01A00000000000000000000000"]);
    seedWatermark(readStateRaw, STALE);

    const logs = captureLogs();
    try {
      const result = await sweepReadStateWatermarks(router, [SPACE]);

      expect(result.repaired).toBe(1);
      // A repair is not news: the per-space line records where the pass acted
      // for an operator who has turned debug on, and the summary line carries
      // the fleet figure at every level.
      expect(logs.debug()).toContain(`read-state watermarks for ${SPACE}`);
      expect(logs.info()).toContain("read-state watermarks: 1 of 1 examined");
      expect(logs.warn()).not.toContain(`read-state watermarks for ${SPACE}`);
    } finally {
      logs.restore();
    }
  });

  test("keeps an unanchorable residue out of the per-space warn lines", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    seedRoom(spaceRaw, ["01B00000000000000000000000"]);
    // Older than the room's only key: nothing survives to anchor to, so this
    // figure is a property of the data, identical on every boot. It belongs in
    // the fleet summary, not in a line per space per boot.
    seedWatermark(readStateRaw, "01A00000000000000000000000");

    const logs = captureLogs();
    try {
      const result = await sweepReadStateWatermarks(router, [SPACE]);

      expect(result.unanchorable).toBe(1);
      expect(logs.debug()).toContain(`read-state watermarks for ${SPACE}`);
      expect(logs.warn()).not.toContain(`read-state watermarks for ${SPACE}`);
      expect(logs.warn()).toContain("read-state watermarks: 1 of 1 examined");
    } finally {
      logs.restore();
    }
  });

  test("ignores the placeholder watermarks a lazily-created row starts with", async () => {
    const { spaceRaw, readStateRaw, router } = fixture();
    seedRoom(spaceRaw, ["01A00000000000000000000000"]);
    seedWatermark(readStateRaw, "0");
    seedWatermark(readStateRaw, "", { roomId: "01ROOMTWO0000000000000000" });

    const result = await sweepReadStateWatermarks(router, [SPACE]);

    // `''` and `'0'` are "no watermark yet", not a lost position — the schema
    // hands them to every first-time reader.
    expect(result.examined).toBe(0);
    expect(result.found).toBe(0);
    expect(result.unanchorable).toBe(0);
  });
});
