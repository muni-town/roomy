import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  openReadStateDb,
  attachInMemoryReadState,
  READSTATE_SCHEMA_VERSION,
} from "./readStateDb.ts";
import { openDb } from "./db.ts";

describe("read-state schema", () => {
  test("applies cleanly on a fresh database and writes the version row", () => {
    const db = openReadStateDb({ path: ":memory:", isolated: true });

    const version = db
      .query<{ version: string }, []>(
        "select version from readstate_schema_version where id = 1",
      )
      .get();
    expect(version?.version).toBe(READSTATE_SCHEMA_VERSION);

    const tables = db
      .query<{ name: string }, []>(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((r) => r.name);

    expect(tables).toContain("read_positions");
  });

  test("attachInMemoryReadState makes readstate.read_positions accessible", () => {
    const mainDb = openDb({ path: ":memory:", isolated: true });
    const readStateDb = attachInMemoryReadState(mainDb);

    // Insert a row via the attached schema.
    mainDb
      .prepare(
        "insert into readstate.read_positions (user_did, room_id, seen_up_to, unread_count) values (?, ?, ?, ?)",
      )
      .run("did:plc:test", "room-1", "idx-10", 5);

    // Read it back.
    const row = mainDb
      .query<{ unread_count: number }, [string, string]>(
        "select unread_count from readstate.read_positions where user_did = ? and room_id = ?",
      )
      .get("did:plc:test", "room-1");
    expect(row?.unread_count).toBe(5);

    // Also accessible via the direct read-state DB handle.
    const direct = readStateDb
      .query<{ unread_count: number }, [string, string]>(
        "select unread_count from read_positions where user_did = ? and room_id = ?",
      )
      .get("did:plc:test", "room-1");
    expect(direct?.unread_count).toBe(5);
  });

  test("cross-DB join works between materialisation and read-state", () => {
    const mainDb = openDb({ path: ":memory:", isolated: true });
    attachInMemoryReadState(mainDb);

    // Seed materialisation tables.
    mainDb.run("insert into entities (id, stream_id) values (?, ?)", [
      "room-1",
      "did:web:space.example",
    ]);
    mainDb.run("insert into entities (id, stream_id) values (?, ?)", [
      "room-2",
      "did:web:space.example",
    ]);

    // Seed read positions.
    mainDb
      .prepare(
        "insert into readstate.read_positions (user_did, room_id, seen_up_to, unread_count) values (?, ?, ?, ?)",
      )
      .run("did:plc:test", "room-1", "idx-5", 3);
    mainDb
      .prepare(
        "insert into readstate.read_positions (user_did, room_id, seen_up_to, unread_count) values (?, ?, ?, ?)",
      )
      .run("did:plc:test", "room-2", "idx-8", 7);

    // Cross-DB join: sum unread for a space.
    const row = mainDb
      .query<{ total: number }, [string, string]>(
        `select coalesce(sum(rp.unread_count), 0) as total
           from readstate.read_positions rp
           join entities e on e.id = rp.room_id
          where rp.user_did = ?
            and e.stream_id = ?`,
      )
      .get("did:plc:test", "did:web:space.example");
    expect(row?.total).toBe(10);
  });
});
