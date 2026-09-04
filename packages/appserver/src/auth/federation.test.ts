import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbLike } from "../db/types.ts";
import { federatedRoomAccess } from "./federation.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SPACE_SCHEMA = join(__dirname, "..", "db", "schema-space.sql");
const GLOBAL_SCHEMA = join(__dirname, "..", "db", "schema-global.sql");

const A = "did:web:space-a.example"; // origin space A
const B = "did:web:space-b.example"; // receiving space B
const USER = "did:plc:bob";
const ADMIN_B = "did:plc:adminB";
const ROLE = "01ROLE0000000000000000000";
const CHANNEL = "01CHANNEL00000000000000000";
const THREAD = "01THREAD000000000000000000";

function freshSpaceDb(): DbLike {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SPACE_SCHEMA, "utf8"));
  return toAsyncDb(db);
}
function freshGlobalDb(): DbLike {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(GLOBAL_SCHEMA, "utf8"));
  return toAsyncDb(db);
}

async function seedSpaceA(spaceDb: DbLike): Promise<void> {
  for (const id of [A, CHANNEL, THREAD]) {
    await spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [id, A]);
  }
  await spaceDb.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [CHANNEL],
  );
  await spaceDb.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [THREAD],
  );
  await spaceDb.run(
    "insert into edges (head, tail, label, payload) values (?, ?, 'link', ?)",
    [CHANNEL, THREAD, JSON.stringify({ canonical_parent: 1 })],
  );
}
async function seedActiveFederationWithOriginGrant(
  globalDb: DbLike,
  permission: string,
): Promise<void> {
  await globalDb.run("insert into edges (head, tail, label) values (?, ?, 'joinedSpace')", [USER, B]);
  await globalDb.run(
    "insert into space_federations (space_id, federating_space_did, status, requested_by_did) values (?, ?, 'active', ?)",
    [A, B, USER],
  );
  await globalDb.run(
    "insert into federation_room_permissions (space_id, federating_space_did, room_id, permission) values (?, ?, ?, ?)",
    [A, B, CHANNEL, permission],
  );
}
async function seedReceiverGrant(
  globalDb: DbLike,
  grantee: string,
  kind: string,
  permission: string,
): Promise<void> {
  await globalDb.run(
    "insert into federation_receiver_permissions (space_id, federating_space_did, room_id, grantee, kind, permission) values (?, ?, ?, ?, ?, ?)",
    [A, B, CHANNEL, grantee, kind, permission],
  );
}
async function seedBAdmin(globalDb: DbLike, bDb: DbLike): Promise<void> {
  await globalDb.run("insert into edges (head, tail, label) values (?, ?, 'joinedSpace')", [ADMIN_B, B]);
  await bDb.run("insert into entities (id, stream_id) values (?, ?)", [B, B]);
  await bDb.run("insert into entities (id, stream_id) values (?, ?)", [ADMIN_B, ADMIN_B]);
  await bDb.run("insert into edges (head, tail, label) values (?, ?, 'admin')", [B, ADMIN_B]);
}
async function seedBRole(bDb: DbLike, roleId: string, userDid: string): Promise<void> {
  await bDb.run("insert into roles (id, stream_id, name) values (?, ?, 'r')", [roleId, B]);
  await bDb.run("insert into member_roles (user_id, role_id, stream_id) values (?, ?, ?)", [userDid, roleId, B]);
}

describe("federation access — origin + receiver grants", () => {
  test("non-admin B member needs a receiver grant (no grant => no access)", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "read");
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: freshSpaceDb });
    expect(fed).toBeNull();
  });

  test("user receiver grant grants read at origin level", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "read");
    await seedReceiverGrant(globalDb, USER, "user", "read");
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: freshSpaceDb });
    expect(fed).not.toBeNull();
    expect(fed!.canRead).toBe(true);
    expect(fed!.canWrite).toBe(false);
    expect(fed!.homeSpaceDid).toBe(B);
  });

  test("readwrite origin + readwrite receiver grant => write", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "readwrite");
    await seedReceiverGrant(globalDb, USER, "user", "readwrite");
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: freshSpaceDb });
    expect(fed!.canWrite).toBe(true);
  });

  test("receiver grant is capped by the origin grant (origin read + receiver readwrite => read)", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "read");
    await seedReceiverGrant(globalDb, USER, "user", "readwrite");
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: freshSpaceDb });
    expect(fed!.canRead).toBe(true);
    expect(fed!.canWrite).toBe(false);
  });

  test("members-wide receiver grant (kind='members', grantee = B) grants every member", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "readwrite");
    // Grantee is B's own space DID; no per-user or per-role row exists.
    await seedReceiverGrant(globalDb, B, "members", "readwrite");
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: freshSpaceDb });
    expect(fed).not.toBeNull();
    expect(fed!.canRead).toBe(true);
    expect(fed!.canWrite).toBe(true);
  });

  test("members-wide grant is capped by the origin grant", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "read");
    await seedReceiverGrant(globalDb, B, "members", "readwrite");
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: freshSpaceDb });
    expect(fed!.canRead).toBe(true);
    expect(fed!.canWrite).toBe(false);
  });

  test("a specific user grant overrides the members-grant baseline", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "readwrite");
    // Members get 'read'; this user is granted 'readwrite' — the per-user
    // (and per-role) grants must raise, not be capped by, the members base.
    await seedReceiverGrant(globalDb, B, "members", "read");
    await seedReceiverGrant(globalDb, USER, "user", "readwrite");
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: freshSpaceDb });
    expect(fed!.canRead).toBe(true);
    expect(fed!.canWrite).toBe(true);
  });

  test("role-based receiver grant grants access to a B role member", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    const bDb = freshSpaceDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "readwrite");
    await seedBRole(bDb, ROLE, USER);
    await seedReceiverGrant(globalDb, ROLE, "role", "readwrite");
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: () => bDb });
    expect(fed!.canRead).toBe(true);
    expect(fed!.canWrite).toBe(true);
  });

  test("B admin gets origin-level access without a receiver grant", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    const bDb = freshSpaceDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "readwrite");
    await seedBAdmin(globalDb, bDb);
    // ADMIN_B is an admin of B (and a member), so they get origin-level access.
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, ADMIN_B, { spaceDbResolver: () => bDb });
    expect(fed).not.toBeNull();
    expect(fed!.canRead).toBe(true);
    expect(fed!.canWrite).toBe(true);
  });

  test("threads inherit federation from their parent channel", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "read");
    await seedReceiverGrant(globalDb, USER, "user", "read");
    const fed = await federatedRoomAccess(spaceDb, globalDb, THREAD, USER, { spaceDbResolver: freshSpaceDb });
    expect(fed).not.toBeNull();
    expect(fed!.canRead).toBe(true);
  });

  test("no origin grant on the channel => no federated access", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "read");
    await seedReceiverGrant(globalDb, USER, "user", "read");
    await globalDb.run(
      "delete from federation_room_permissions where space_id = ? and federating_space_did = ? and room_id = ?",
      [A, B, CHANNEL],
    );
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: freshSpaceDb });
    expect(fed).toBeNull();
  });

  test("inactive federation => null", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "read");
    await seedReceiverGrant(globalDb, USER, "user", "read");
    await globalDb.run(
      "update space_federations set status = 'rejected' where space_id = ? and federating_space_did = ?",
      [A, B],
    );
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: freshSpaceDb });
    expect(fed).toBeNull();
  });

  test("caller not a member of the receiving space => null", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "read");
    await seedReceiverGrant(globalDb, USER, "user", "read");
    await globalDb.run("delete from edges where head = ? and label = 'joinedSpace'", [USER]);
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: freshSpaceDb });
    expect(fed).toBeNull();
  });

  test("a B-banned member loses access despite a receiver grant", async () => {
    const spaceDb = freshSpaceDb();
    const globalDb = freshGlobalDb();
    const bDb = freshSpaceDb();
    await seedSpaceA(spaceDb);
    await seedActiveFederationWithOriginGrant(globalDb, "readwrite");
    await seedReceiverGrant(globalDb, USER, "user", "readwrite");
    // USER is a member of B but is now banned there.
    await bDb.run("insert into entities (id, stream_id) values (?, ?)", [B, B]);
    await bDb.run("insert into entities (id, stream_id) values (?, ?)", [USER, USER]);
    await bDb.run("insert into edges (head, tail, label) values (?, ?, 'member')", [B, USER]);
    await bDb.run("insert into comp_bans (entity, user_did) values (?, ?)", [B, USER]);
    const fed = await federatedRoomAccess(spaceDb, globalDb, CHANNEL, USER, { spaceDbResolver: () => bDb });
    expect(fed).toBeNull();
  });
});
