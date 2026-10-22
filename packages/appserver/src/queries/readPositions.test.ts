/**
 * The sidebar's read-position anchor: the statement, its plan, and the promise
 * that the rewrite changed no answer.
 *
 * `ensureReadPositions` runs on every `space.getMetadata` — for every channel
 * and every engaged thread — so its anchor statement sits on the app's hottest
 * read path. `max(sort_idx) group by room` visits every entity of every room in
 * the list; the correlated form seeks one row per room, provided SQLite keeps
 * the seek inside `idx_entities_room_sort`. Both halves are asserted here, with
 * statistics present, which is the state a boot leaves each space in.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { UserDid } from "@roomy-space/sdk";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { newestSortIdxByRoom, newestSortIdxByRoomSql } from "../db/roomAnchors.ts";
import type { DbLike } from "../db/types.ts";
import { ensureReadPositions } from "./readPositions.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SPACE_SCHEMA_PATH = join(__dirname, "..", "db", "schema-space.sql");
const READSTATE_SCHEMA_PATH = join(__dirname, "..", "db", "readStateSchema.sql");

const SPACE = "did:web:space.example";
const STREAM = "did:web:space.example";
const USER = UserDid.assert("did:plc:reader");

/** The anchor as it stood before the rewrite — the shape the plan test replaces. */
const GROUP_BY_MAX_SQL = `select room as room_id, max(sort_idx) as newest
    from entities
   where room in (select value from json_each(?1))
   group by room`;

/**
 * A statement's plan detail, plus whether SQLite aggregates over the scan.
 *
 * The aggregate is read from the bytecode, not the plan: `max()` over a grouped
 * scan renders as `SEARCH entities USING …`, the same line a bounded seek
 * produces, so the plan alone cannot tell a per-room seek from a walk of the
 * room. An `AggStep` whose `p4` names `max` is that walk.
 */
function inspect(
  db: Database,
  sql: string,
  rooms: string[],
): { plan: string; aggregates: string[] } {
  const param = JSON.stringify(rooms);
  const plan = db
    .query(`explain query plan ${sql}`)
    .all(param)
    .map((row) => (row as { detail: string }).detail)
    .join(" | ");
  const aggregates = db
    .query(`explain ${sql}`)
    .all(param)
    .filter((step) => (step as { opcode: string }).opcode === "AggStep")
    .map((step) => (step as { p4: string | null }).p4 ?? "");
  return { plan, aggregates };
}

/** An in-memory DB seeded with one of the shipped schema files. */
function freshDb(schemaPath: string): Database {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(schemaPath, "utf8"));
  return db;
}

/** Insert `count` keyed entities into `room`, keys `prefix` + padded index. */
function seedRoom(db: Database, room: string, count: number): void {
  const insert = db.prepare(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
  );
  for (let i = 0; i < count; i++) {
    insert.run(`${room}-${i}`, STREAM, room, String(i).padStart(4, "0"));
  }
}

describe("read-position anchor plan", () => {
  test("seeks idx_entities_room_sort per room and aggregates nothing", () => {
    const db = freshDb(SPACE_SCHEMA_PATH);
    for (let r = 0; r < 12; r++) seedRoom(db, `room${r}`, 400);
    db.exec("analyze");

    const anchor = inspect(db, newestSortIdxByRoomSql, ["room1", "room7"]);
    expect(anchor.plan).toContain("SEARCH entities USING COVERING INDEX idx_entities_room_sort");
    expect(anchor.plan).not.toMatch(/\bSCAN entities\b/);
    expect(anchor.plan).not.toContain("TEMP B-TREE");
    // `max(sort_idx) group by room` is exactly this step.
    expect(anchor.aggregates).toEqual([]);
  });

  /**
   * The regression the rewrite removes, pinned so the test above means
   * something: the statement it replaces aggregated over each room's scan.
   */
  test("the statement it replaces aggregated over every entity of a room", () => {
    const db = freshDb(SPACE_SCHEMA_PATH);
    for (let r = 0; r < 12; r++) seedRoom(db, `room${r}`, 400);
    db.exec("analyze");

    expect(inspect(db, GROUP_BY_MAX_SQL, ["room1", "room7"]).aggregates).toEqual(["max(1)"]);
  });
});

describe("read-position anchor results", () => {
  test("agrees with the grouped max on every room it names, and nulls the rest", async () => {
    const db = freshDb(SPACE_SCHEMA_PATH);
    seedRoom(db, "busy", 300);
    seedRoom(db, "sparse", 3);
    seedRoom(db, "unkeyed", 5);
    db.exec("update entities set sort_idx = null where room = 'unkeyed'");
    // A keyed room that also holds unkeyed rows: the anchor is over keys only.
    seedRoom(db, "mixed", 40);
    db.run("insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, null)", [
      "mixed-tail",
      STREAM,
      "mixed",
    ]);
    db.exec("analyze");

    const roomIds = ["busy", "sparse", "unkeyed", "mixed", "empty"];
    const oldRows = db.query(GROUP_BY_MAX_SQL).all(JSON.stringify(roomIds)) as Array<{
      room_id: string;
      newest: string | null;
    }>;
    const anchors = await newestSortIdxByRoom(toAsyncDb(db), roomIds);

    // The old statement omitted rooms holding no keyed entity; the new one
    // reports them as null. Every room either statement names agrees.
    expect([...anchors.keys()].sort()).toEqual([...roomIds].sort());
    for (const row of oldRows) expect(anchors.get(row.room_id)).toBe(row.newest);
    expect(anchors.get("unkeyed")).toBeNull();
    expect(anchors.get("empty")).toBeNull();
    // `mixed-tail` is unkeyed, so it cannot be the anchor.
    expect(anchors.get("mixed")).toBe("0039");
    expect(anchors.get("busy")).toBe("0299");
  });

  test("no rooms costs no statement", async () => {
    const db = freshDb(SPACE_SCHEMA_PATH);
    expect(await newestSortIdxByRoom(toAsyncDb(db), [])).toEqual(new Map());
  });
});

describe("ensureReadPositions", () => {
  /**
   * The row's creation point: a reader with no position in a room is anchored
   * at that room's newest key, so the room opens with nothing unread. A room
   * with no keyed entity anchors at the `"0"` placeholder, which reads as
   * "nothing unread" against an empty room.
   */
  test("anchors a new row at the room's newest key, or '0' when the room is empty", async () => {
    const spaceDb = freshDb(SPACE_SCHEMA_PATH);
    seedRoom(spaceDb, "busy", 60);
    seedRoom(spaceDb, "cold", 0);
    spaceDb.exec("analyze");

    const readState = freshDb(READSTATE_SCHEMA_PATH);
    await ensureReadPositions(
      toAsyncDb(readState),
      toAsyncDb(spaceDb),
      SPACE,
      USER,
      ["busy", "cold"],
    );

    const rows = readState
      .query("select room_id, seen_up_to, space_did from read_positions where user_did = ? order by room_id")
      .all(USER);
    expect(rows).toEqual([
      { room_id: "busy", seen_up_to: "0059", space_did: SPACE },
      { room_id: "cold", seen_up_to: "0", space_did: SPACE },
    ]);
  });

  /** The insert is `do nothing`: a position the user owns must never move. */
  test("leaves an existing position alone", async () => {
    const spaceDb = freshDb(SPACE_SCHEMA_PATH);
    seedRoom(spaceDb, "busy", 60);
    spaceDb.exec("analyze");

    const readState = freshDb(READSTATE_SCHEMA_PATH);
    const db: DbLike = toAsyncDb(readState);
    await ensureReadPositions(db, toAsyncDb(spaceDb), SPACE, USER, ["busy"]);
    await spaceDb.run("update entities set sort_idx = '9999' where id = 'busy-59'");

    await ensureReadPositions(db, toAsyncDb(spaceDb), SPACE, USER, ["busy"]);

    const row = readState
      .query("select seen_up_to from read_positions where user_did = ? and room_id = 'busy'")
      .get(USER);
    expect(row).toEqual({ seen_up_to: "0059" });
  });
});
