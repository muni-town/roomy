import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamDid, UserDid } from "@roomy-space/sdk";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import {
  JOINED_SPACE_LABEL,
  recordPersonalSpaceMembership,
  selectJoinedSpaces,
} from "./joinedSpaces.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

const USER = UserDid.assert("did:plc:test-user");
const PERSONAL = StreamDid.assert("did:web:personal-stream.example");
const OTHER_PERSONAL = StreamDid.assert("did:web:other-personal.example");
const SPACE = StreamDid.assert("did:web:space-stream.example");

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  // Apply main schema
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [
    SCHEMA_VERSION,
  ]);
  // Attach and apply readstate schema (needed by getSpaceUnreadCount; separate exec calls to avoid bun:sqlite multi-stmt issue)
  db.exec("attach database ':memory:' as readstate");
  db.exec(
    "create table if not exists readstate_schema_version (id integer primary key check (id = 1), version text not null) strict",
  );
  db.exec(
    "create table if not exists readstate.read_positions (user_did text not null, room_id text not null, seen_up_to text not null, unread_count integer not null default 0, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict",
  );
  db.exec(
    "create table if not exists readstate.user_thread_activity (user_did text not null, thread_id text not null, last_active_at integer not null, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, thread_id)) strict",
  );
  db.run(
    "insert or replace into readstate_schema_version (id, version) values (1, ?)",
    ["2"],
  );
  return { db, asyncDb: toAsyncDb(db) };
}

/** Seed an entity row. `stream_id` defaults to the entity's own id. */
function seedEntity(db: Database, id: string, streamId: string = id): void {
  db.run("insert into entities (id, stream_id) values (?, ?)", [id, streamId]);
}

/**
 * Seed the rows the *space stream's* own materialisation produces: the space
 * + user entities, the space's name, and the creator's admin/member edges.
 * This is space-global truth — it says nothing about who has joined.
 */
function seedSpace(db: Database): void {
  seedEntity(db, SPACE);
  seedEntity(db, USER);
  db.run("insert into comp_info (entity, name) values (?, ?)", [
    SPACE,
    "Test Space",
  ]);
  db.run("insert into edges (head, tail, label) values (?, ?, 'admin')", [
    SPACE,
    USER,
  ]);
  db.run("insert into edges (head, tail, label) values (?, ?, 'member')", [
    SPACE,
    USER,
  ]);
}

/** Seed a `joinedSpace` edge: `personal` has joined `space`. */
function joinEdge(db: Database, personal: string, space: string): void {
  db.run("insert into edges (head, tail, label) values (?, ?, ?)", [
    personal,
    space,
    JOINED_SPACE_LABEL,
  ]);
}

describe("selectJoinedSpaces", () => {
  test("a space the personal stream has a joinedSpace edge to is visible", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db);
    seedEntity(db, PERSONAL);
    joinEdge(db, PERSONAL, SPACE);

    const spaces = await selectJoinedSpaces(asyncDb, USER, PERSONAL);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({
      id: SPACE,
      name: "Test Space",
      isMember: true,
      isAdmin: true,
    });
  });

  test("a space with no joinedSpace edge is invisible even if it exists", async () => {
    const { db, asyncDb } = freshDb();
    // Space fully materialised (entity, info, member edge) but the personal
    // stream never joined it — no joinedSpace edge.
    seedSpace(db);
    seedEntity(db, PERSONAL);

    expect(await selectJoinedSpaces(asyncDb, USER, PERSONAL)).toEqual([]);
  });

  test("a space joined by a different personal stream is not visible (multi-user)", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db);
    seedEntity(db, PERSONAL);
    seedEntity(db, OTHER_PERSONAL);
    // Another user joined the same space. Their edge must not leak into ours.
    joinEdge(db, OTHER_PERSONAL, SPACE);

    expect(await selectJoinedSpaces(asyncDb, USER, PERSONAL)).toEqual([]);
  });

  test("a joined space the caller is banned from is excluded", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db);
    seedEntity(db, PERSONAL);
    joinEdge(db, PERSONAL, SPACE);
    db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    expect(await selectJoinedSpaces(asyncDb, USER, PERSONAL)).toEqual([]);
  });

  test("a joined space with no member/admin edge for the caller is excluded", async () => {
    const { db, asyncDb } = freshDb();
    // joinedSpace intent exists, but the space stream never recorded the
    // member edge (e.g. join not yet accepted) — not a real membership.
    seedEntity(db, SPACE);
    seedEntity(db, PERSONAL);
    db.run("insert into comp_info (entity, name) values (?, ?)", [
      SPACE,
      "Test Space",
    ]);
    joinEdge(db, PERSONAL, SPACE);

    expect(await selectJoinedSpaces(asyncDb, USER, PERSONAL)).toEqual([]);
  });
});

describe("recordPersonalSpaceMembership", () => {
  test("makes an already-materialised space visible to getSpaces", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db);
    expect(await selectJoinedSpaces(asyncDb, USER, PERSONAL)).toEqual([]);

    await recordPersonalSpaceMembership(asyncDb, SPACE, PERSONAL);

    const spaces = await selectJoinedSpaces(asyncDb, USER, PERSONAL);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ id: SPACE, name: "Test Space" });
  });

  test("seeds the entity rows the joinedSpace edge depends on", async () => {
    const { db, asyncDb } = freshDb();
    // Neither the space nor the personal stream entity exists yet.
    await recordPersonalSpaceMembership(asyncDb, SPACE, PERSONAL);

    const edge = db
      .query<
        { head: string; tail: string },
        [string]
      >("select head, tail from edges where label = ?")
      .get(JOINED_SPACE_LABEL);
    expect(edge).toEqual({ head: PERSONAL, tail: SPACE });

    // The space entity is scoped to its own stream, not the personal stream.
    const spaceEntity = db
      .query<
        { stream_id: string },
        [string]
      >("select stream_id from entities where id = ?")
      .get(SPACE);
    expect(spaceEntity?.stream_id).toBe(SPACE);
  });

  test("is idempotent", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db);

    await recordPersonalSpaceMembership(asyncDb, SPACE, PERSONAL);
    await recordPersonalSpaceMembership(asyncDb, SPACE, PERSONAL);

    expect(await selectJoinedSpaces(asyncDb, USER, PERSONAL)).toHaveLength(1);
  });
});
