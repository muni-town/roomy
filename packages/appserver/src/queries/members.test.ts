/**
 * Tests for the `selectMembers` query helper behind
 * `space.roomy.space.getMembers`.
 *
 * Covers the unfiltered list (members + external admins + roles + admin flag)
 * and the `search` substring filter used by the chat-input mention typeahead.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import { selectMembers } from "./members.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

const SPACE = "did:web:space-stream.example";

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [
    SCHEMA_VERSION,
  ]);
  return { db, asyncDb: toAsyncDb(db) };
}
function seedEntity(
  db: Database,
  id: string,
  streamId: string = id,
): void {
  db.run("insert into entities (id, stream_id) values (?, ?)", [id, streamId]);
}

/** Seed a user: entity + handle + optional profile name/avatar. */
function seedUser(
  db: Database,
  did: string,
  opts: { handle?: string; name?: string; avatar?: string } = {},
): void {
  seedEntity(db, did, SPACE);
  if (opts.handle !== undefined) {
    db.run("insert into comp_user (did, handle) values (?, ?)", [
      did,
      opts.handle,
    ]);
  }
  const infoCols: string[] = [];
  const infoBinds: (string | number)[] = [did];
  if (opts.name !== undefined) {
    infoCols.push("name");
    infoBinds.push(opts.name);
  }
  if (opts.avatar !== undefined) {
    infoCols.push("avatar");
    infoBinds.push(opts.avatar);
  }
  if (infoCols.length > 0) {
    db.run(
      `insert into comp_info (entity, ${infoCols.join(", ")}) values (?, ${infoCols.map(() => "?").join(", ")})`,
      infoBinds,
    );
  }
}

function seedEdge(
  db: Database,
  head: string,
  tail: string,
  label: string,
): void {
  db.run("insert into edges (head, tail, label) values (?, ?, ?)", [
    head,
    tail,
    label,
  ]);
}

interface SeedOpts {
  did: string;
  handle?: string;
  name?: string;
  avatar?: string;
  member?: boolean;
  admin?: boolean;
  roleIds?: [string, string][];
}

/** Seed the space + a user with their membership/admin edges + roles. */
function seedSpaceWithUsers(db: Database, users: SeedOpts[]): void {
  seedEntity(db, SPACE);
  for (const u of users) {
    seedUser(db, u.did, {
      handle: u.handle,
      name: u.name,
      avatar: u.avatar,
    });
    if (u.member) seedEdge(db, SPACE, u.did, "member");
    if (u.admin) seedEdge(db, SPACE, u.did, "admin");
    for (const [roleId] of u.roleIds ?? []) {
      db.run(
        "insert into member_roles (user_id, role_id, stream_id) values (?, ?, ?)",
        [u.did, roleId, SPACE],
      );
    }
  }
}

describe("selectMembers", () => {
  test("returns members with profile, admin flag, and roles", async () => {
    const { db, asyncDb } = freshDb();
    seedSpaceWithUsers(db, [
      {
        did: "did:plc:alice",
        handle: "alice.bsky.social",
        name: "Alice",
        member: true,
        admin: true,
        roleIds: [["01ROLEA00000000000000000", ""]],
      },
      {
        did: "did:plc:bob",
        handle: "bob.bsky.social",
        name: "Bob",
        member: true,
      },
    ]);

    const { members, externalAdmins } = await selectMembers(asyncDb, SPACE);

    expect(members).toHaveLength(2);
    const alice = members.find((m) => m.did === "did:plc:alice")!;
    expect(alice.handle).toBe("alice.bsky.social");
    expect(alice.name).toBe("Alice");
    expect(alice.isAdmin).toBe(true);
    expect(alice.roleIds).toEqual(["01ROLEA00000000000000000"]);
    const bob = members.find((m) => m.did === "did:plc:bob")!;
    expect(bob.isAdmin).toBe(false);
    expect(bob.roleIds).toEqual([]);
    expect(externalAdmins).toEqual([]);
  });

  test("external admins (admin edge, no member edge) are separated out", async () => {
    const { db, asyncDb } = freshDb();
    seedSpaceWithUsers(db, [
      { did: "did:plc:alice", handle: "alice.bsky.social", member: true },
      { did: "did:plc:admin", handle: "admin.bsky.social", admin: true },
    ]);

    const { members, externalAdmins } = await selectMembers(asyncDb, SPACE);

    expect(members.map((m) => m.did)).toEqual(["did:plc:alice"]);
    expect(externalAdmins.map((a) => a.did)).toEqual(["did:plc:admin"]);
    // externalAdmins carry profile fields but no isAdmin/roleIds.
    expect(externalAdmins[0]!.handle).toBe("admin.bsky.social");
    expect("isAdmin" in externalAdmins[0]!).toBe(false);
  });

  test("null profile fields are stripped (not present on the wire)", async () => {
    const { db, asyncDb } = freshDb();
    // Unhydrated member: no comp_user handle, no comp_info name/avatar.
    seedSpaceWithUsers(db, [
      { did: "did:plc:ghost", member: true },
    ]);

    const { members } = await selectMembers(asyncDb, SPACE);
    expect(members).toHaveLength(1);
    expect(members[0]!.did).toBe("did:plc:ghost");
    expect("handle" in members[0]!).toBe(false);
    expect("name" in members[0]!).toBe(false);
    expect("avatar" in members[0]!).toBe(false);
  });

  test("search filters members by handle (case-insensitive substring)", async () => {
    const { db, asyncDb } = freshDb();
    seedSpaceWithUsers(db, [
      { did: "did:plc:alice", handle: "alice.bsky.social", name: "Ms A", member: true },
      { did: "did:plc:bob", handle: "bob.bsky.social", name: "Mr B", member: true },
      { did: "did:plc:carol", handle: "carol.bsky.social", name: "Ms C", member: true },
    ]);

    const { members } = await selectMembers(asyncDb, SPACE, "ALIC");
    expect(members.map((m) => m.did)).toEqual(["did:plc:alice"]);
  });

  test("search filters members by name", async () => {
    const { db, asyncDb } = freshDb();
    seedSpaceWithUsers(db, [
      { did: "did:plc:alice", handle: "alice.bsky.social", name: "Alice In Wonderland", member: true },
      { did: "did:plc:zoe", handle: "z.bsky.social", name: "Zoe", member: true },
    ]);

    expect((await selectMembers(asyncDb, SPACE, "wonderland")).members.map((m) => m.did)).toEqual([
      "did:plc:alice",
    ]);
  });

  test("search filters members by DID", async () => {
    const { db, asyncDb } = freshDb();
    seedSpaceWithUsers(db, [
      { did: "did:plc:zzz000wonderland", handle: "z.bsky.social", name: "Zoe", member: true },
      { did: "did:plc:alice", handle: "alice.bsky.social", name: "Alice", member: true },
    ]);

    expect(
      (await selectMembers(asyncDb, SPACE, "zzz000wonderland")).members.map((m) => m.did),
    ).toEqual(["did:plc:zzz000wonderland"]);
  });

  test("search also filters external admins", async () => {
    const { db, asyncDb } = freshDb();
    seedSpaceWithUsers(db, [
      { did: "did:plc:alice", handle: "alice.bsky.social", name: "Alice", member: true },
      { did: "did:plc:rootadmin", handle: "root.bsky.social", name: "Root", admin: true },
    ]);

    const { members, externalAdmins } = await selectMembers(asyncDb, SPACE, "root");
    expect(members).toEqual([]);
    expect(externalAdmins.map((a) => a.did)).toEqual(["did:plc:rootadmin"]);
  });

  test("empty/whitespace search returns everyone (no filter)", async () => {
    const { db, asyncDb } = freshDb();
    seedSpaceWithUsers(db, [
      { did: "did:plc:alice", handle: "alice.bsky.social", member: true },
      { did: "did:plc:bob", handle: "bob.bsky.social", member: true },
    ]);

    expect((await selectMembers(asyncDb, SPACE, "")).members).toHaveLength(2);
    expect((await selectMembers(asyncDb, SPACE, "   ")).members).toHaveLength(2);
  });

  test("search with no matches returns empty arrays", async () => {
    const { db, asyncDb } = freshDb();
    seedSpaceWithUsers(db, [
      { did: "did:plc:alice", handle: "alice.bsky.social", member: true },
    ]);

    const { members, externalAdmins } = await selectMembers(asyncDb, SPACE, "nobody");
    expect(members).toEqual([]);
    expect(externalAdmins).toEqual([]);
  });
});
