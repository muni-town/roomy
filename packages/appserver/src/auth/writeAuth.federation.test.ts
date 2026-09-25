import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbLike } from "../db/types.ts";
import { checkWriteAuth } from "./writeAuth.ts";
import { newUlid } from "@roomy-space/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const GLOBAL_SCHEMA_PATH = join(__dirname, "..", "db", "schema-global.sql");
const SCHEMA_VERSION = "10-appserver.4";

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

function freshGlobalDb(): DbLike {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
  return toAsyncDb(db);
}

const A = "did:web:space-a.example"; // origin space A
const B = "did:web:space-b.example"; // federating space B
const USER = "did:plc:bob";
const ADMIN_A = "did:plc:adminA";
const ADMIN_B = "did:plc:adminB";
const MEMBER_A = "did:plc:memberA";

async function seedSpace(db: DbLike, spaceId: string): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [
    spaceId,
    spaceId,
  ]);
  await db.run("insert into comp_space (entity) values (?)", [spaceId]);
}
async function seedUser(db: DbLike, did: string): Promise<void> {
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
}
async function addEdge(
  db: DbLike,
  head: string,
  tail: string,
  label: string,
): Promise<void> {
  await db.run("insert into edges (head, tail, label) values (?, ?, ?)", [
    head,
    tail,
    label,
  ]);
}
async function seedChannel(
  db: DbLike,
  channelId: string,
  spaceId: string,
  defaultAccess: "readwrite" | "read" | "none" = "none",
): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [channelId, spaceId]);
  await db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', ?)",
    [channelId, defaultAccess],
  );
}

function requestEvent(spaceB: string) {
  return { $type: "space.roomy.federation.request.v0", id: newUlid(), federatingSpaceDid: spaceB };
}
function respondEvent(spaceB: string, approve: boolean) {
  return { $type: "space.roomy.federation.respond.v0", id: newUlid(), federatingSpaceDid: spaceB, approve };
}
function removeEvent(spaceB: string) {
  return { $type: "space.roomy.federation.remove.v0", id: newUlid(), federatingSpaceDid: spaceB };
}
function createMessageEvent(roomId: string) {
  return { $type: "space.roomy.message.createMessage.v0", id: newUlid(), room: roomId };
}
function setRoomPermEvent(spaceB: string, roomId: string, permission: string | null) {
  return { $type: "space.roomy.federation.setRoomPermission.v0", id: newUlid(), federatingSpaceDid: spaceB, roomId, permission };
}

async function seedRequestContext(opts: { memberA: string; adminA?: boolean; adminB?: boolean }) {
  const { asyncDb: aDb } = freshDb();
  const { asyncDb: bDb } = freshDb();
  await seedSpace(aDb, A);
  await seedSpace(bDb, B);
  await seedUser(aDb, opts.memberA);
  await seedUser(bDb, opts.memberA);
  await addEdge(aDb, A, opts.memberA, "member");
  if (opts.adminB) await addEdge(bDb, B, opts.memberA, "admin");
  return { aDb, bDb };
}

describe("auth/writeAuth — federation request", () => {
  test("admin of B who is a member of A can request", async () => {
    const { aDb, bDb } = await seedRequestContext({ memberA: ADMIN_B, adminB: true });
    const result = await checkWriteAuth(aDb, A, ADMIN_B, requestEvent(B), { dbResolver: () => bDb });
    expect(result).toBeUndefined();
  });

  test("admin of B but NOT a member of A is denied", async () => {
    const { aDb, bDb } = await seedRequestContext({ memberA: ADMIN_B });
    // no member edge on A
    const result = await checkWriteAuth(aDb, A, ADMIN_B, requestEvent(B), { dbResolver: () => bDb });
    expect(result?.status).toBe(403);
  });

  test("member of A but not admin of B is denied", async () => {
    const { aDb, bDb } = await seedRequestContext({ memberA: MEMBER_A, adminB: false });
    const result = await checkWriteAuth(aDb, A, MEMBER_A, requestEvent(B), { dbResolver: () => bDb });
    expect(result?.status).toBe(403);
  });

  test("denied when no cross-space resolver is provided", async () => {
    const { aDb } = await seedRequestContext({ memberA: ADMIN_B });
    const result = await checkWriteAuth(aDb, A, ADMIN_B, requestEvent(B));
    expect(result?.status).toBe(403);
  });

  test("missing federatingSpaceDid is a 400", async () => {
    const { aDb } = await seedRequestContext({ memberA: ADMIN_B });
    const result = await checkWriteAuth(aDb, A, ADMIN_B, {
      $type: "space.roomy.federation.request.v0",
      id: newUlid(),
    });
    expect(result?.status).toBe(400);
  });

  test("re-requesting while an active federation exists is a 409", async () => {
    const { aDb, bDb } = await seedRequestContext({ memberA: ADMIN_B, adminB: true });
    const globalDb = freshGlobalDb();
    await globalDb.run(
      "insert into space_federations (space_id, federating_space_did, status, requested_by_did) values (?, ?, 'active', ?)",
      [A, B, ADMIN_B],
    );
    const result = await checkWriteAuth(aDb, A, ADMIN_B, requestEvent(B), { dbResolver: () => bDb, globalDb: globalDb });
    expect(result?.status).toBe(409);
  });

  test("re-requesting while pending is allowed (idempotent no-op)", async () => {
    const { aDb, bDb } = await seedRequestContext({ memberA: ADMIN_B, adminB: true });
    const globalDb = freshGlobalDb();
    await globalDb.run(
      "insert into space_federations (space_id, federating_space_did, status, requested_by_did) values (?, ?, 'pending', ?)",
      [A, B, ADMIN_B],
    );
    const result = await checkWriteAuth(aDb, A, ADMIN_B, requestEvent(B), { dbResolver: () => bDb, globalDb: globalDb });
    expect(result).toBeUndefined();
  });

  test("re-requesting after a federation was removed is allowed (recovery path)", async () => {
    const { aDb, bDb } = await seedRequestContext({ memberA: ADMIN_B, adminB: true });
    const globalDb = freshGlobalDb();
    await globalDb.run(
      "insert into space_federations (space_id, federating_space_did, status, requested_by_did) values (?, ?, 'removed', ?)",
      [A, B, ADMIN_B],
    );
    const result = await checkWriteAuth(aDb, A, ADMIN_B, requestEvent(B), { dbResolver: () => bDb, globalDb: globalDb });
    expect(result).toBeUndefined();
  });

  test("re-requesting after a rejected federation is a 409", async () => {
    const { aDb, bDb } = await seedRequestContext({ memberA: ADMIN_B, adminB: true });
    const globalDb = freshGlobalDb();
    await globalDb.run(
      "insert into space_federations (space_id, federating_space_did, status, requested_by_did) values (?, ?, 'rejected', ?)",
      [A, B, ADMIN_B],
    );
    const result = await checkWriteAuth(aDb, A, ADMIN_B, requestEvent(B), { dbResolver: () => bDb, globalDb: globalDb });
    expect(result?.status).toBe(409);
  });
});

describe("auth/writeAuth — federation respond/remove", () => {
  test("admin of A can respond (approve)", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, ADMIN_A);
    await addEdge(aDb, A, ADMIN_A, "admin");
    const result = await checkWriteAuth(aDb, A, ADMIN_A, respondEvent(B, true));
    expect(result).toBeUndefined();
  });

  test("admin of A cannot respond to a pending-less federation (missing = 404)", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, ADMIN_A);
    await addEdge(aDb, A, ADMIN_A, "admin");
    const globalDb = freshGlobalDb();
    const result = await checkWriteAuth(aDb, A, ADMIN_A, respondEvent(B, true), { globalDb: globalDb });
    expect(result?.status).toBe(404);
  });

  test("admin of A cannot respond to an already-active federation (409)", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, ADMIN_A);
    await addEdge(aDb, A, ADMIN_A, "admin");
    const globalDb = freshGlobalDb();
    await globalDb.run(
      "insert into space_federations (space_id, federating_space_did, status, requested_by_did) values (?, ?, 'active', ?)",
      [A, B, ADMIN_A],
    );
    const result = await checkWriteAuth(aDb, A, ADMIN_A, respondEvent(B, true), { globalDb: globalDb });
    expect(result?.status).toBe(409);
  });

  test("admin of A cannot respond to a removed federation (409, no resurrect)", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, ADMIN_A);
    await addEdge(aDb, A, ADMIN_A, "admin");
    const globalDb = freshGlobalDb();
    await globalDb.run(
      "insert into space_federations (space_id, federating_space_did, status, requested_by_did) values (?, ?, 'removed', ?)",
      [A, B, ADMIN_A],
    );
    const result = await checkWriteAuth(aDb, A, ADMIN_A, respondEvent(B, true), { globalDb: globalDb });
    expect(result?.status).toBe(409);
  });

  test("non-admin of A cannot respond", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, MEMBER_A);
    await addEdge(aDb, A, MEMBER_A, "member");
    const result = await checkWriteAuth(aDb, A, MEMBER_A, respondEvent(B, true));
    expect(result?.status).toBe(403);
  });

  test("admin of A can remove", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, ADMIN_A);
    await addEdge(aDb, A, ADMIN_A, "admin");
    const result = await checkWriteAuth(aDb, A, ADMIN_A, removeEvent(B));
    expect(result).toBeUndefined();
  });

  test("admin of B can remove the federation (B-side revocation)", async () => {
    const { asyncDb: aDb } = freshDb();
    const { asyncDb: bDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, ADMIN_B);
    await addEdge(aDb, A, ADMIN_B, "member");
    await seedSpace(bDb, B);
    await seedUser(bDb, ADMIN_B);
    await addEdge(bDb, B, ADMIN_B, "admin");
    // ADMIN_B is not an admin of A, but is an admin of B.
    const result = await checkWriteAuth(aDb, A, ADMIN_B, removeEvent(B), { dbResolver: () => bDb });
    expect(result).toBeUndefined();
  });

  test("a non-admin of both sides cannot remove", async () => {
    const { asyncDb: aDb } = freshDb();
    const { asyncDb: bDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, MEMBER_A);
    await addEdge(aDb, A, MEMBER_A, "member");
    await seedSpace(bDb, B);
    await seedUser(bDb, MEMBER_A);
    await addEdge(bDb, B, MEMBER_A, "member");
    const result = await checkWriteAuth(aDb, A, MEMBER_A, removeEvent(B), { dbResolver: () => bDb });
    expect(result?.status).toBe(403);
  });

  test("admin of A can set an origin grant", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, ADMIN_A);
    await addEdge(aDb, A, ADMIN_A, "admin");
    const result = await checkWriteAuth(aDb, A, ADMIN_A, setRoomPermEvent(B, "01CHANNEL00000000000000000", "read"));
    expect(result).toBeUndefined();
  });

  test("non-admin of A cannot set an origin permission", async () => {
    const { asyncDb: aDb } = freshDb();
    await seedSpace(aDb, A);
    await seedUser(aDb, MEMBER_A);
    await addEdge(aDb, A, MEMBER_A, "member");
    const result = await checkWriteAuth(aDb, A, MEMBER_A, setRoomPermEvent(B, "01CHANNEL00000000000000000", "read"));
    expect(result?.status).toBe(403);
  });
});

describe("auth/writeAuth — federation setReceiverPermission", () => {
  function setReceiverEvent(origin: string, roomId: string, grantee: string, kind: string, permission: string | null) {
    return { $type: "space.roomy.federation.setReceiverPermission.v0", id: newUlid(), originSpaceId: origin, roomId, grantee, kind, permission };
  }

  test("admin of B can set a receiver grant (targets B's stream)", async () => {
    const { asyncDb: bDb } = freshDb();
    await seedSpace(bDb, B);
    await seedUser(bDb, ADMIN_B);
    await addEdge(bDb, B, ADMIN_B, "admin");
    const result = await checkWriteAuth(bDb, B, ADMIN_B, setReceiverEvent(A, "01CHANNEL00000000000000000", "did:plc:bob", "user", "read"));
    expect(result).toBeUndefined();
  });

  test("non-admin of B cannot set a receiver grant", async () => {
    const { asyncDb: bDb } = freshDb();
    await seedSpace(bDb, B);
    await seedUser(bDb, MEMBER_A);
    await addEdge(bDb, B, MEMBER_A, "member");
    const result = await checkWriteAuth(bDb, B, MEMBER_A, setReceiverEvent(A, "01CHANNEL00000000000000000", "did:plc:bob", "user", "read"));
    expect(result?.status).toBe(403);
  });

  test("admin of B cannot grant on a channel A has not exposed (409)", async () => {
    const { asyncDb: bDb } = freshDb();
    await seedSpace(bDb, B);
    await seedUser(bDb, ADMIN_B);
    await addEdge(bDb, B, ADMIN_B, "admin");
    const globalDb = freshGlobalDb();
    // Active federation, but NO origin grant for the channel.
    await globalDb.run(
      "insert into space_federations (space_id, federating_space_did, status, requested_by_did) values (?, ?, 'active', ?)",
      [A, B, ADMIN_B],
    );
    const result = await checkWriteAuth(bDb, B, ADMIN_B, setReceiverEvent(A, "01CHANNEL00000000000000000", "did:plc:bob", "user", "read"), { globalDb: globalDb });
    expect(result?.status).toBe(409);
  });

  test("admin of B can grant on a channel A has exposed via an active origin grant", async () => {
    const { asyncDb: bDb } = freshDb();
    await seedSpace(bDb, B);
    await seedUser(bDb, ADMIN_B);
    await addEdge(bDb, B, ADMIN_B, "admin");
    const globalDb = freshGlobalDb();
    await globalDb.run(
      "insert into space_federations (space_id, federating_space_did, status, requested_by_did) values (?, ?, 'active', ?)",
      [A, B, ADMIN_B],
    );
    await globalDb.run(
      "insert into federation_room_permissions (space_id, federating_space_did, room_id, permission) values (?, ?, ?, 'readwrite')",
      [A, B, "01CHANNEL00000000000000000"],
    );
    const result = await checkWriteAuth(bDb, B, ADMIN_B, setReceiverEvent(A, "01CHANNEL00000000000000000", "did:plc:bob", "user", "read"), { globalDb: globalDb });
    expect(result).toBeUndefined();
  });

  test("admin of B can always clear a receiver grant (null) even without an origin grant", async () => {
    const { asyncDb: bDb } = freshDb();
    await seedSpace(bDb, B);
    await seedUser(bDb, ADMIN_B);
    await addEdge(bDb, B, ADMIN_B, "admin");
    const globalDb = freshGlobalDb();
    const result = await checkWriteAuth(bDb, B, ADMIN_B, setReceiverEvent(A, "01CHANNEL00000000000000000", "did:plc:bob", "user", null), { globalDb: globalDb });
    expect(result).toBeUndefined();
  });
});

describe("auth/writeAuth — federated writes", () => {
  const CHANNEL = "01CHANNEL00000000000000000";

  async function seedFederatedWriteContext(receiverPermission: string) {
    const { asyncDb: aDb } = freshDb();
    const { asyncDb: bDb } = freshDb();
    const globalDb = freshGlobalDb();
    await seedSpace(aDb, A);
    await seedChannel(aDb, CHANNEL, A, "none"); // native access denies for a non-member
    await seedSpace(bDb, B);
    await seedUser(bDb, USER);
    await addEdge(bDb, B, USER, "member");
    await globalDb.run("insert into edges (head, tail, label) values (?, ?, 'joinedSpace')", [USER, B]);
    await globalDb.run(
      "insert into space_federations (space_id, federating_space_did, status, requested_by_did) values (?, ?, 'active', ?)",
      [A, B, USER],
    );
    await globalDb.run(
      "insert into federation_room_permissions (space_id, federating_space_did, room_id, permission) values (?, ?, ?, 'readwrite')",
      [A, B, CHANNEL],
    );
    await globalDb.run(
      "insert into federation_receiver_permissions (space_id, federating_space_did, room_id, grantee, kind, permission) values (?, ?, ?, ?, 'user', ?)",
      [A, B, CHANNEL, USER, receiverPermission],
    );
    return { aDb, bDb, globalDb };
  }

  test("B member with readwrite origin + receiver grants can write to a federated channel", async () => {
    const { aDb, bDb, globalDb } = await seedFederatedWriteContext("readwrite");
    const result = await checkWriteAuth(aDb, A, USER, createMessageEvent(CHANNEL), { dbResolver: () => bDb, globalDb: globalDb });
    expect(result).toBeUndefined();
  });

  test("B member with only a read receiver grant cannot write", async () => {
    const { aDb, bDb, globalDb } = await seedFederatedWriteContext("read");
    const result = await checkWriteAuth(aDb, A, USER, createMessageEvent(CHANNEL), { dbResolver: () => bDb, globalDb: globalDb });
    expect(result?.status).toBe(403);
  });

  test("B member with no receiver grant cannot write", async () => {
    const { aDb, bDb, globalDb } = await seedFederatedWriteContext("read");
    await globalDb.run("delete from federation_receiver_permissions where room_id = ?", [CHANNEL]);
    const result = await checkWriteAuth(aDb, A, USER, createMessageEvent(CHANNEL), { dbResolver: () => bDb, globalDb: globalDb });
    expect(result?.status).toBe(403);
  });
});
