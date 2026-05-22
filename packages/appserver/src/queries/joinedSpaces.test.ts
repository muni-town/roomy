import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { StreamDid, UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { attachInMemoryReadState } from "../db/readStateDb.ts";
import {
  JOINED_SPACE_LABEL,
  recordPersonalSpaceMembership,
  selectJoinedSpaces,
} from "./joinedSpaces.ts";

const USER = UserDid.assert("did:plc:test-user");
const PERSONAL = StreamDid.assert("did:web:personal-stream.example");
const OTHER_PERSONAL = StreamDid.assert("did:web:other-personal.example");
const SPACE = StreamDid.assert("did:web:space-stream.example");

function freshDb(): Database {
  const db = openDb({ path: ":memory:", isolated: true });
  attachInMemoryReadState(db);
  return db;
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
  test("a space the personal stream has a joinedSpace edge to is visible", () => {
    const db = freshDb();
    seedSpace(db);
    seedEntity(db, PERSONAL);
    joinEdge(db, PERSONAL, SPACE);

    const spaces = selectJoinedSpaces(db, USER, PERSONAL);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({
      id: SPACE,
      name: "Test Space",
      isMember: true,
      isAdmin: true,
    });
  });

  test("a space with no joinedSpace edge is invisible even if it exists", () => {
    const db = freshDb();
    // Space fully materialised (entity, info, member edge) but the personal
    // stream never joined it — no joinedSpace edge.
    seedSpace(db);
    seedEntity(db, PERSONAL);

    expect(selectJoinedSpaces(db, USER, PERSONAL)).toEqual([]);
  });

  test("a space joined by a different personal stream is not visible (multi-user)", () => {
    const db = freshDb();
    seedSpace(db);
    seedEntity(db, PERSONAL);
    seedEntity(db, OTHER_PERSONAL);
    // Another user joined the same space. Their edge must not leak into ours.
    joinEdge(db, OTHER_PERSONAL, SPACE);

    expect(selectJoinedSpaces(db, USER, PERSONAL)).toEqual([]);
  });

  test("a joined space the caller is banned from is excluded", () => {
    const db = freshDb();
    seedSpace(db);
    seedEntity(db, PERSONAL);
    joinEdge(db, PERSONAL, SPACE);
    db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    expect(selectJoinedSpaces(db, USER, PERSONAL)).toEqual([]);
  });

  test("a joined space with no member/admin edge for the caller is excluded", () => {
    const db = freshDb();
    // joinedSpace intent exists, but the space stream never recorded the
    // member edge (e.g. join not yet accepted) — not a real membership.
    seedEntity(db, SPACE);
    seedEntity(db, PERSONAL);
    db.run("insert into comp_info (entity, name) values (?, ?)", [
      SPACE,
      "Test Space",
    ]);
    joinEdge(db, PERSONAL, SPACE);

    expect(selectJoinedSpaces(db, USER, PERSONAL)).toEqual([]);
  });
});

describe("recordPersonalSpaceMembership", () => {
  test("makes an already-materialised space visible to getSpaces", () => {
    const db = freshDb();
    seedSpace(db);
    expect(selectJoinedSpaces(db, USER, PERSONAL)).toEqual([]);

    recordPersonalSpaceMembership(db, SPACE, PERSONAL);

    const spaces = selectJoinedSpaces(db, USER, PERSONAL);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ id: SPACE, name: "Test Space" });
  });

  test("seeds the entity rows the joinedSpace edge depends on", () => {
    const db = freshDb();
    // Neither the space nor the personal stream entity exists yet.
    recordPersonalSpaceMembership(db, SPACE, PERSONAL);

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

  test("is idempotent", () => {
    const db = freshDb();
    seedSpace(db);

    recordPersonalSpaceMembership(db, SPACE, PERSONAL);
    recordPersonalSpaceMembership(db, SPACE, PERSONAL);

    expect(selectJoinedSpaces(db, USER, PERSONAL)).toHaveLength(1);
  });
});
