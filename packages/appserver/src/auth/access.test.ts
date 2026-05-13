import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../db/db.ts";
import {
  isAdmin,
  isBanned,
  isMember,
  roomAccess,
  spaceAccess,
} from "./access.ts";

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
}

const SPACE = "did:web:space.example";
const USER = "did:plc:alice";
const OTHER_USER = "did:plc:bob";
const CHANNEL = "01CHANNEL00000000000000000";
const THREAD = "01THREAD000000000000000000";
const ROLE = "01ROLE0000000000000000000";

function seedSpace(db: Database, spaceId = SPACE): void {
  db.run(
    "insert into entities (id, stream_id) values (?, ?)",
    [spaceId, spaceId],
  );
  db.run("insert into comp_space (entity) values (?)", [spaceId]);
}

function seedUser(db: Database, did: string): void {
  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
    did,
    did,
  ]);
}

function seedChannel(
  db: Database,
  channelId: string,
  spaceId: string,
  defaultAccess: "readwrite" | "read" | "none" = "readwrite",
): void {
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    channelId,
    spaceId,
  ]);
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', ?)",
    [channelId, defaultAccess],
  );
}

function seedThread(
  db: Database,
  threadId: string,
  channelId: string,
  spaceId: string,
): void {
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    threadId,
    spaceId,
  ]);
  // Thread rooms have no default_access of their own.
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [threadId],
  );
  // Canonical 'link' edge: head=channel, tail=thread.
  db.run(
    `insert into edges (head, tail, label, payload)
       values (?, ?, 'link', json_object('canonical_parent', 1))`,
    [channelId, threadId],
  );
}

function addEdge(
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

function addRole(
  db: Database,
  roleId: string,
  spaceId: string,
  userDid: string,
  roomId: string,
  permission: "read" | "readwrite",
): void {
  db.run(
    "insert or ignore into roles (id, stream_id, deleted) values (?, ?, 0)",
    [roleId, spaceId],
  );
  db.run(
    "insert or ignore into member_roles (user_id, role_id, stream_id) values (?, ?, ?)",
    [userDid, roleId, spaceId],
  );
  db.run(
    "insert into role_rooms (role_id, room_id, stream_id, permission) values (?, ?, ?, ?)",
    [roleId, roomId, spaceId, permission],
  );
}

describe("auth/access — membership, admin, ban", () => {
  test("isMember reflects member edge presence", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);

    expect(isMember(db, SPACE, USER)).toBe(false);
    addEdge(db, SPACE, USER, "member");
    expect(isMember(db, SPACE, USER)).toBe(true);
  });

  test("isAdmin reflects admin edge presence; orthogonal to membership", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);

    addEdge(db, SPACE, USER, "admin");
    expect(isAdmin(db, SPACE, USER)).toBe(true);
    expect(isMember(db, SPACE, USER)).toBe(false);
  });

  test("isBanned reflects comp_bans presence", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);

    expect(isBanned(db, SPACE, USER)).toBe(false);
    db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);
    expect(isBanned(db, SPACE, USER)).toBe(true);
  });

  test("spaceAccess composes the three signals", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "member");
    addEdge(db, SPACE, USER, "admin");

    expect(spaceAccess(db, SPACE, USER)).toEqual({
      isMember: true,
      isAdmin: true,
      isBanned: false,
    });
  });
});

describe("auth/access — room access", () => {
  test("nonexistent room returns exists=false and no permissions", () => {
    const db = freshDb();
    const result = roomAccess(db, "01MISSING000000000000000000", USER);
    expect(result.exists).toBe(false);
    expect(result.canRead).toBe(false);
    expect(result.canWrite).toBe(false);
    expect(result.spaceId).toBe(null);
  });

  test("default_access=readwrite grants read to anyone, write to members", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "readwrite");
    seedUser(db, USER);

    // Non-member: read yes, write no.
    const nonMember = roomAccess(db, CHANNEL, USER);
    expect(nonMember.exists).toBe(true);
    expect(nonMember.canRead).toBe(true);
    expect(nonMember.canWrite).toBe(false);
    expect(nonMember.isAdmin).toBe(false);
    expect(nonMember.defaultAccess).toBe("readwrite");
    expect(nonMember.spaceId).toBe(SPACE);

    // After joining: write also granted.
    addEdge(db, SPACE, USER, "member");
    const member = roomAccess(db, CHANNEL, USER);
    expect(member.canRead).toBe(true);
    expect(member.canWrite).toBe(true);
  });

  test("default_access=read grants read only", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "read");
    seedUser(db, USER);

    const result = roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(false);
  });

  test("default_access=none denies non-admin without role grant", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "none");
    seedUser(db, USER);

    const result = roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(false);
    expect(result.canWrite).toBe(false);
  });

  test("admin overrides default_access=none", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "none");
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "admin");

    const result = roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(true);
    expect(result.isAdmin).toBe(true);
  });

  test("admin without member edge still has access (orthogonal)", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "none");
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "admin");
    // No member edge.

    expect(roomAccess(db, CHANNEL, USER).canRead).toBe(true);
  });

  test("role grant adds read on default_access=none channel", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "none");
    seedUser(db, USER);
    addRole(db, ROLE, SPACE, USER, CHANNEL, "read");

    const result = roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(false);
  });

  test("role grant 'readwrite' adds write on default_access=read channel", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "read");
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "member"); // write requires membership
    addRole(db, ROLE, SPACE, USER, CHANNEL, "readwrite");

    const result = roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(true);
  });

  test("soft-deleted roles do not grant permissions", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "none");
    seedUser(db, USER);
    addRole(db, ROLE, SPACE, USER, CHANNEL, "readwrite");
    db.run("update roles set deleted = 1 where id = ?", [ROLE]);

    const result = roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(false);
  });

  test("role grant for another user does not affect this caller", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "none");
    seedUser(db, USER);
    seedUser(db, OTHER_USER);
    addRole(db, ROLE, SPACE, OTHER_USER, CHANNEL, "readwrite");

    expect(roomAccess(db, CHANNEL, USER).canRead).toBe(false);
    expect(roomAccess(db, CHANNEL, OTHER_USER).canRead).toBe(true);
  });

  test("threads inherit default_access from canonical parent channel", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "none");
    seedThread(db, THREAD, CHANNEL, SPACE);
    seedUser(db, USER);

    const result = roomAccess(db, THREAD, USER);
    expect(result.exists).toBe(true);
    expect(result.defaultAccess).toBe("none");
    expect(result.parentChannelId).toBe(CHANNEL);
    expect(result.canRead).toBe(false);
  });

  test("thread access follows role grant on parent channel", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "none");
    seedThread(db, THREAD, CHANNEL, SPACE);
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "member"); // write requires membership
    addRole(db, ROLE, SPACE, USER, CHANNEL, "readwrite");

    const result = roomAccess(db, THREAD, USER);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(true);
  });

  test("thread inherits readwrite from parent when parent is readwrite", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "readwrite");
    seedThread(db, THREAD, CHANNEL, SPACE);
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "member"); // write requires membership

    const result = roomAccess(db, THREAD, USER);
    expect(result.defaultAccess).toBe("readwrite");
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(true);
  });

  test("ban overrides everything — even admin", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "readwrite");
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "admin");
    db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    const result = roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(false);
    expect(result.canWrite).toBe(false);
    expect(result.isAdmin).toBe(false);
    expect(result.isBanned).toBe(true);
  });
});
