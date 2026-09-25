import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbLike } from "../db/types.ts";
import {
  isAdmin,
  isBanned,
  isMember,
  roomAccess,
  roomAccessMany,
  spaceAccess,
} from "./access.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
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

const SPACE = "did:web:space.example";
const USER = "did:plc:alice";
const OTHER_USER = "did:plc:bob";
const CHANNEL = "01CHANNEL00000000000000000";
const THREAD = "01THREAD000000000000000000";
const ROLE = "01ROLE0000000000000000000";
const SECOND_THREAD = "01THREAD00000000000000000B";
const OTHER_CHANNEL = "01CHANNEL0000000000000000B";

async function seedSpace(db: DbLike, spaceId = SPACE): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [
    spaceId,
    spaceId,
  ]);
  await db.run("insert into comp_space (entity) values (?)", [spaceId]);
}

async function seedUser(db: DbLike, did: string): Promise<void> {
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
    did,
    did,
  ]);
}

async function seedChannel(
  db: DbLike,
  channelId: string,
  spaceId: string,
  defaultAccess: "readwrite" | "read" | "none" = "readwrite",
): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [
    channelId,
    spaceId,
  ]);
  await db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', ?)",
    [channelId, defaultAccess],
  );
}

async function seedThread(
  db: DbLike,
  threadId: string,
  channelId: string,
  spaceId: string,
): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [
    threadId,
    spaceId,
  ]);
  // Thread rooms have no default_access of their own.
  await db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [threadId],
  );
  // Canonical 'link' edge: head=channel, tail=thread.
  await db.run(
    `insert into edges (head, tail, label, payload)
       values (?, ?, 'link', json_object('canonical_parent', 1))`,
    [channelId, threadId],
  );
}

/**
 * Seed a thread with an explicit (non-null) default_access, simulating the
 * scenario where a thread was created or updated with its own access level.
 * The auth layer should still clamp it against the parent channel.
 */
async function seedThreadWithAccess(
  db: DbLike,
  threadId: string,
  channelId: string,
  spaceId: string,
  defaultAccess: "readwrite" | "read" | "none",
): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [
    threadId,
    spaceId,
  ]);
  await db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', ?)",
    [threadId, defaultAccess],
  );
  await db.run(
    `insert into edges (head, tail, label, payload)
       values (?, ?, 'link', json_object('canonical_parent', 1))`,
    [channelId, threadId],
  );
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

async function addRole(
  db: DbLike,
  roleId: string,
  spaceId: string,
  userDid: string,
  roomId: string,
  permission: "read" | "readwrite",
): Promise<void> {
  await db.run(
    "insert or ignore into roles (id, stream_id, deleted) values (?, ?, 0)",
    [roleId, spaceId],
  );
  await db.run(
    "insert or ignore into member_roles (user_id, role_id, stream_id) values (?, ?, ?)",
    [userDid, roleId, spaceId],
  );
  await db.run(
    "insert into role_rooms (role_id, room_id, stream_id, permission) values (?, ?, ?, ?)",
    [roleId, roomId, spaceId, permission],
  );
}

describe("auth/access — membership, admin, ban", () => {
  test("isMember reflects member edge presence", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);

    expect(await isMember(db, SPACE, USER)).toBe(false);
    await addEdge(db, SPACE, USER, "member");
    expect(await isMember(db, SPACE, USER)).toBe(true);
  });

  test("isAdmin reflects admin edge presence; orthogonal to membership", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);

    await addEdge(db, SPACE, USER, "admin");
    expect(await isAdmin(db, SPACE, USER)).toBe(true);
    expect(await isMember(db, SPACE, USER)).toBe(false);
  });

  test("isBanned reflects comp_bans presence", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);

    expect(await isBanned(db, SPACE, USER)).toBe(false);
    await db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);
    expect(await isBanned(db, SPACE, USER)).toBe(true);
  });

  test("spaceAccess composes the three signals", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    await addEdge(db, SPACE, USER, "admin");

    expect(await spaceAccess(db, SPACE, USER)).toEqual({
      isMember: true,
      isAdmin: true,
      isBanned: false,
    });
  });
});

describe("auth/access — room access", () => {
  test("nonexistent room returns exists=false and no permissions", async () => {
    const { asyncDb: db } = freshDb();
    const result = await roomAccess(db, "01MISSING000000000000000000", USER);
    expect(result.exists).toBe(false);
    expect(result.canRead).toBe(false);
    expect(result.canWrite).toBe(false);
    expect(result.spaceId).toBe(null);
  });

  test("default_access=readwrite grants read to anyone, write to members", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);

    // Non-member: read yes, write no.
    const nonMember = await roomAccess(db, CHANNEL, USER);
    expect(nonMember.exists).toBe(true);
    expect(nonMember.canRead).toBe(true);
    expect(nonMember.canWrite).toBe(false);
    expect(nonMember.isAdmin).toBe(false);
    expect(nonMember.defaultAccess).toBe("readwrite");
    expect(nonMember.spaceId).toBe(SPACE);

    // After joining: write also granted.
    await addEdge(db, SPACE, USER, "member");
    const member = await roomAccess(db, CHANNEL, USER);
    expect(member.canRead).toBe(true);
    expect(member.canWrite).toBe(true);
  });

  test("default_access=read grants read only", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "read");
    await seedUser(db, USER);

    const result = await roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(false);
  });

  test("default_access=none denies non-admin without role grant", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedUser(db, USER);

    const result = await roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(false);
    expect(result.canWrite).toBe(false);
  });

  test("admin overrides default_access=none", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "admin");

    const result = await roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(true);
    expect(result.isAdmin).toBe(true);
  });

  test("admin without member edge still has access (orthogonal)", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "admin");
    // No member edge.

    expect((await roomAccess(db, CHANNEL, USER)).canRead).toBe(true);
  });

  test("role grant adds read on default_access=none channel", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedUser(db, USER);
    await addRole(db, ROLE, SPACE, USER, CHANNEL, "read");

    const result = await roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(false);
  });

  test("role grant 'readwrite' adds write on default_access=read channel", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "read");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member"); // write requires membership
    await addRole(db, ROLE, SPACE, USER, CHANNEL, "readwrite");

    const result = await roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(true);
  });

  test("soft-deleted roles do not grant permissions", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedUser(db, USER);
    await addRole(db, ROLE, SPACE, USER, CHANNEL, "readwrite");
    await db.run("update roles set deleted = 1 where id = ?", [ROLE]);

    const result = await roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(false);
  });

  test("role grant for another user does not affect this caller", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedUser(db, USER);
    await seedUser(db, OTHER_USER);
    await addRole(db, ROLE, SPACE, OTHER_USER, CHANNEL, "readwrite");

    expect((await roomAccess(db, CHANNEL, USER)).canRead).toBe(false);
    expect((await roomAccess(db, CHANNEL, OTHER_USER)).canRead).toBe(true);
  });

  test("threads inherit default_access from canonical parent channel", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedThread(db, THREAD, CHANNEL, SPACE);
    await seedUser(db, USER);

    const result = await roomAccess(db, THREAD, USER);
    expect(result.exists).toBe(true);
    expect(result.defaultAccess).toBe("none");
    expect(result.parentChannelId).toBe(CHANNEL);
    expect(result.canRead).toBe(false);
  });

  test("thread access follows role grant on parent channel", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedThread(db, THREAD, CHANNEL, SPACE);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member"); // write requires membership
    await addRole(db, ROLE, SPACE, USER, CHANNEL, "readwrite");

    const result = await roomAccess(db, THREAD, USER);
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(true);
  });

  test("thread inherits readwrite from parent when parent is readwrite", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedThread(db, THREAD, CHANNEL, SPACE);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member"); // write requires membership

    const result = await roomAccess(db, THREAD, USER);
    expect(result.defaultAccess).toBe("readwrite");
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(true);
  });

  test("thread with explicit defaultAccess='read' is clamped to parent's 'none'", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedThreadWithAccess(db, THREAD, CHANNEL, SPACE, "read");
    await seedUser(db, USER);

    const result = await roomAccess(db, THREAD, USER);
    expect(result.defaultAccess).toBe("none");
    expect(result.canRead).toBe(false);
    expect(result.canWrite).toBe(false);
  });

  test("thread with explicit defaultAccess='readwrite' is clamped to parent's 'none'", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedThreadWithAccess(db, THREAD, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);

    const result = await roomAccess(db, THREAD, USER);
    expect(result.defaultAccess).toBe("none");
    expect(result.canRead).toBe(false);
  });

  test("thread with explicit defaultAccess='readwrite' is clamped to parent's 'read'", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "read");
    await seedThreadWithAccess(db, THREAD, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);

    const result = await roomAccess(db, THREAD, USER);
    expect(result.defaultAccess).toBe("read");
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(false);
  });

  test("thread can be more restrictive than parent channel", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedThreadWithAccess(db, THREAD, CHANNEL, SPACE, "read");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await roomAccess(db, THREAD, USER);
    // Thread's own 'read' is more restrictive than parent's 'readwrite',
    // so it should be honored (no clamping needed).
    expect(result.defaultAccess).toBe("read");
    expect(result.canRead).toBe(true);
    expect(result.canWrite).toBe(false);
  });

  test("role grant still works on thread clamped to parent's 'none'", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedThreadWithAccess(db, THREAD, CHANNEL, SPACE, "read");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    await addRole(db, ROLE, SPACE, USER, CHANNEL, "read");

    const result = await roomAccess(db, THREAD, USER);
    expect(result.defaultAccess).toBe("none");
    // Role grant on parent channel should still provide access.
    expect(result.canRead).toBe(true);
  });

  test("ban overrides thread clamping", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "read");
    await seedThreadWithAccess(db, THREAD, CHANNEL, SPACE, "read");
    await seedUser(db, USER);
    await db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    const result = await roomAccess(db, THREAD, USER);
    expect(result.canRead).toBe(false);
    expect(result.isBanned).toBe(true);
  });

  test("ban overrides everything — even admin", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "admin");
    await db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    const result = await roomAccess(db, CHANNEL, USER);
    expect(result.canRead).toBe(false);
    expect(result.canWrite).toBe(false);
    expect(result.isAdmin).toBe(false);
    expect(result.isBanned).toBe(true);
  });
});

describe("auth/access — roomAccessMany parity", () => {
  test("matches roomAccess for a mixed batch (channels, threads, roles, ban, admin)", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);

    const CH1 = "01CHANNEL10000000000000000";
    const CH2 = "01CHANNEL20000000000000000";
    const CH3 = "01CHANNEL30000000000000000";
    const TH1 = "01THREAD100000000000000000";
    const TH2 = "01THREAD200000000000000000";
    const MISSING = "01MISSING000000000000000000";

    // readwrite channel (member)
    await seedChannel(db, CH1, SPACE, "readwrite");
    // read channel (member)
    await seedChannel(db, CH2, SPACE, "read");
    // none channel with a role grant for USER
    await seedChannel(db, CH3, SPACE, "none");
    await addRole(db, ROLE, SPACE, USER, CH3, "read");
    // thread under CH1 (inherits readwrite)
    await seedThread(db, TH1, CH1, SPACE);
    // thread under CH3 (clamped to none, but role grant on CH3 grants read)
    await seedThread(db, TH2, CH3, SPACE);

    await addEdge(db, SPACE, USER, "member");

    const roomIds = [CH1, CH2, CH3, TH1, TH2, MISSING];

    // Individual roomAccess (fresh memo per call).
    const individual = new Map<string, Awaited<ReturnType<typeof roomAccess>>>();
    for (const id of roomIds) {
      individual.set(id, await roomAccess(db, id, USER));
    }

    // Batched roomAccessMany (single memo).
    const batched = await roomAccessMany(db, roomIds, USER);

    for (const id of roomIds) {
      const a = individual.get(id)!;
      const b = batched.get(id)!;
      expect(b, `roomAccessMany(${id})`).toBeDefined();
      expect(b.exists).toBe(a.exists);
      expect(b.canRead).toBe(a.canRead);
      expect(b.canWrite).toBe(a.canWrite);
      expect(b.isAdmin).toBe(a.isAdmin);
      expect(b.defaultAccess).toBe(a.defaultAccess);
      expect(b.spaceId).toBe(a.spaceId);
      expect(b.parentChannelId).toBe(a.parentChannelId);
      expect(b.isBanned).toBe(a.isBanned);
    }
  });

  test("matches roomAccess for banned and admin callers", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);

    const CH1 = "01CHANNEL10000000000000000";
    const CH2 = "01CHANNEL20000000000000000";
    await seedChannel(db, CH1, SPACE, "readwrite");
    await seedChannel(db, CH2, SPACE, "none");

    // USER is admin on the space.
    await addEdge(db, SPACE, USER, "admin");

    const roomIds = [CH1, CH2];

    const individual = new Map<string, Awaited<ReturnType<typeof roomAccess>>>();
    for (const id of roomIds) {
      individual.set(id, await roomAccess(db, id, USER));
    }
    const batched = await roomAccessMany(db, roomIds, USER);
    for (const id of roomIds) {
      const a = individual.get(id)!;
      const b = batched.get(id)!;
      expect(b.canRead).toBe(a.canRead);
      expect(b.canWrite).toBe(a.canWrite);
      expect(b.isAdmin).toBe(a.isAdmin);
      expect(b.defaultAccess).toBe(a.defaultAccess);
    }

    // Now ban the admin — ban must override admin in both paths.
    await db.run("insert into comp_bans (entity, user_did) values (?, ?)", [SPACE, USER]);
    const individualBanned = new Map<string, Awaited<ReturnType<typeof roomAccess>>>();
    for (const id of roomIds) {
      individualBanned.set(id, await roomAccess(db, id, USER));
    }
    const batchedBanned = await roomAccessMany(db, roomIds, USER);
    for (const id of roomIds) {
      const a = individualBanned.get(id)!;
      const b = batchedBanned.get(id)!;
      expect(b.canRead).toBe(a.canRead);
      expect(b.canWrite).toBe(a.canWrite);
      expect(b.isAdmin).toBe(a.isAdmin);
      expect(b.isBanned).toBe(a.isBanned);
    }
  });

  test("empty input returns empty map", async () => {
    const { asyncDb: db } = freshDb();
    expect((await roomAccessMany(db, [], USER)).size).toBe(0);
  });
});

// ─── room_access read projection ──────────────────────────────────────────
//
// The projection pre-joins a room's owning space and canonical parent channel.
// Its contract is: a room served from a WARMED projection resolves exactly as
// it does from the live tables, and an access-level change written directly to
// `comp_room` is observed immediately (the projection deliberately does not
// cache `default_access`, because that is a security input any writer of
// comp_room can change and the projection is not maintained during replay).

describe("room_access projection", () => {
  /** Populate the projection for the seeded rooms, as a live event would. */
  async function warm(db: DbLike, roomIds: string[]): Promise<void> {
    const ph = roomIds.map(() => "?").join(",");
    await db.run(
      `insert or replace into room_access (room_id, space_id, parent_channel_id)
       select e.id, e.stream_id, p.head
         from entities e
         left join edges p
                on p.tail = e.id and p.label = 'link'
               and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
        where e.id in (${ph})`,
      ...roomIds,
    );
  }

  test("a projected room resolves identically to an unprojected one", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    await seedChannel(db, CHANNEL, SPACE, "read");
    await seedThread(db, THREAD, CHANNEL, SPACE);
    await seedThreadWithAccess(db, SECOND_THREAD, CHANNEL, SPACE, "readwrite");

    // Cold (no projection rows): live-path resolution.
    const coldChannel = await roomAccess(db, CHANNEL, USER);
    const coldThread = await roomAccess(db, THREAD, USER);
    const coldClamped = await roomAccess(db, SECOND_THREAD, USER);

    await warm(db, [CHANNEL, THREAD, SECOND_THREAD]);

    const warmChannel = await roomAccess(db, CHANNEL, USER);
    const warmThread = await roomAccess(db, THREAD, USER);
    const warmClamped = await roomAccess(db, SECOND_THREAD, USER);

    for (const [cold, warm] of [
      [coldChannel, warmChannel],
      [coldThread, warmThread],
      [coldClamped, warmClamped],
    ] as const) {
      expect(warm).toEqual(cold);
    }
    // The thread inherits the channel's MORE RESTRICTIVE access either way.
    expect(warmClamped.defaultAccess).toBe("read");
  });

  test("an access change to comp_room is observed with a warmed projection", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await warm(db, [CHANNEL]);

    expect((await roomAccess(db, CHANNEL, USER)).canRead).toBe(true);

    // A writer that does NOT touch the projection — a replayed updateRoom
    // inside a boot gap, or any out-of-band write. The projection must not be
    // able to serve a stale authorisation decision here.
    await db.run("update comp_room set default_access = 'none' where entity = ?", [CHANNEL]);

    const after = await roomAccess(db, CHANNEL, USER);
    expect(after.defaultAccess).toBe("none");
    expect(after.canRead).toBe(false);
  });

  test("a channel re-parented in the live tables is not served stale", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    await seedChannel(db, CHANNEL, SPACE, "readwrite");

    // Project the thread BEFORE it has a parent link — the read warms its own
    // row, so this is exactly the state a warmed miss produces.
    await seedChannel(db, THREAD, SPACE, "readwrite");
    await roomAccess(db, THREAD, USER);

    // Now link it to the channel. A live event maintains the projection; this
    // write bypasses that on purpose to pin the observable behaviour.
    await db.run(
      `insert into edges (head, tail, label, payload)
         values (?, ?, 'link', json_object('canonical_parent', 1))`,
      [CHANNEL, THREAD],
    );

    const projected = await roomAccess(db, THREAD, USER);
    // Without maintenance the projection still says "no parent"; the point of
    // this test is that the ACCESS value is nonetheless live, so the room
    // still resolves as readable rather than being wrongly denied.
    expect(projected.canRead).toBe(true);
    expect(projected.defaultAccess).toBe("readwrite");
  });

  test("roomAccessMany and roomAccess agree for projected and unprojected rooms", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedThread(db, THREAD, CHANNEL, SPACE);
    await seedChannel(db, OTHER_CHANNEL, SPACE, "none");

    // Project only the channel and thread; leave OTHER_CHANNEL to the fallback.
    await warm(db, [CHANNEL, THREAD]);

    const ids = [CHANNEL, THREAD, OTHER_CHANNEL];
    const batched = await roomAccessMany(db, ids, USER);
    for (const id of ids) {
      expect(batched.get(id)).toEqual(await roomAccess(db, id, USER));
    }
    expect(batched.get(OTHER_CHANNEL)!.canRead).toBe(false);
  });
});
