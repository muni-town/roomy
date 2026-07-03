import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbLike } from "../db/types.ts";
import {
  checkWriteAuth,
  ALLOWED_TYPES,
  REJECTED_TYPES,
} from "./writeAuth.ts";
import { newUlid } from "@roomy-space/sdk";

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
const ADMIN = "did:plc:admin";
const OTHER = "did:plc:bob";
const CHANNEL = "01CHANNEL00000000000000000";
const ROLE = "01ROLE0000000000000000000";

// ── Seed helpers (same pattern as access.test.ts) ─────────────────────

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

/** Helper: make a minimal valid createMessage event object */
function createMessageEvent(roomId: string) {
  return {
    id: newUlid(),
    $type: "space.roomy.message.createMessage.v0",
    room: roomId,
    body: { content: "hello", mimeType: "text/plain" },
    extensions: {},
  };
}

/** Helper: make a minimal editMessage event */
function editMessageEvent(roomId: string, messageId: string) {
  return {
    id: newUlid(),
    $type: "space.roomy.message.editMessage.v0",
    room: roomId,
    messageId,
    body: { content: "edited", mimeType: "text/plain" },
    extensions: {},
  };
}

/** Helper: make a deleteMessage event */
function deleteMessageEvent(roomId: string, messageId: string) {
  return {
    id: newUlid(),
    $type: "space.roomy.message.deleteMessage.v0",
    room: roomId,
    messageId,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("auth/writeAuth — rejected types", () => {
  test("personal.joinSpace is rejected with 400", async () => {
    const { asyncDb: db } = freshDb();
    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.personal.joinSpace.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
    expect(result!.error).toBe("InvalidRequest");
  });

  test("personal.leaveSpace is rejected with 400", async () => {
    const { asyncDb: db } = freshDb();
    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.personal.leaveSpace.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
  });

  test("markRead is rejected with 400", async () => {
    const { asyncDb: db } = freshDb();
    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.state.markRead.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
  });

  test("unknown type is rejected with 400", async () => {
    const { asyncDb: db } = freshDb();
    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.fake.event.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
    expect(result!.message).toContain("Unknown event type");
  });
});

describe("auth/writeAuth — room write events", () => {
  test("member can write to a readwrite room", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(
      db,
      SPACE,
      USER,
      createMessageEvent(CHANNEL),
    );
    expect(result).toBeUndefined();
  });

  test("non-member cannot write to a readwrite room", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    // No member edge

    const result = await checkWriteAuth(
      db,
      SPACE,
      USER,
      createMessageEvent(CHANNEL),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
  });

  test("admin can always write", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");

    const result = await checkWriteAuth(
      db,
      SPACE,
      ADMIN,
      createMessageEvent(CHANNEL),
    );
    expect(result).toBeUndefined();
  });

  test("banned user cannot write", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    await db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    const result = await checkWriteAuth(
      db,
      SPACE,
      USER,
      createMessageEvent(CHANNEL),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
  });

  test("missing room field returns 400", async () => {
    const { asyncDb: db } = freshDb();
    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.message.createMessage.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
    expect(result!.message).toContain("room");
  });

  test("nonexistent room returns 404", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(
      db,
      SPACE,
      USER,
      createMessageEvent("01MISSING000000000000000000"),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(404);
  });
});

describe("auth/writeAuth — edit/delete author check", () => {
  async function seedMessageWithAuthor(
    db: DbLike,
    messageId: string,
    roomId: string,
    authorDid: string,
  ) {
    await db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      messageId,
      SPACE,
      roomId,
    ]);
    await addEdge(db, messageId, authorDid, "author");
  }

  test("author can edit own message", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    const msgId = newUlid();
    await seedMessageWithAuthor(db, msgId, CHANNEL, USER);

    const result = await checkWriteAuth(
      db,
      SPACE,
      USER,
      editMessageEvent(CHANNEL, msgId),
    );
    expect(result).toBeUndefined();
  });

  test("non-author non-admin cannot edit message", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await seedUser(db, OTHER);
    await addEdge(db, SPACE, USER, "member");
    await addEdge(db, SPACE, OTHER, "member");
    const msgId = newUlid();
    await seedMessageWithAuthor(db, msgId, CHANNEL, USER);

    const result = await checkWriteAuth(
      db,
      SPACE,
      OTHER,
      editMessageEvent(CHANNEL, msgId),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
    expect(result!.message).toContain("author");
  });

  test("admin can edit anyone's message", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");
    const msgId = newUlid();
    await seedMessageWithAuthor(db, msgId, CHANNEL, USER);

    const result = await checkWriteAuth(
      db,
      SPACE,
      ADMIN,
      deleteMessageEvent(CHANNEL, msgId),
    );
    expect(result).toBeUndefined();
  });
});

describe("auth/writeAuth — room manage events", () => {
  test("admin can create room", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");

    const result = await checkWriteAuth(db, SPACE, ADMIN, {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.channel",
    });
    expect(result).toBeUndefined();
  });

  test("member cannot create room", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.channel",
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
    expect(result!.message).toContain("admin");
  });
});

describe("auth/writeAuth — space manage events", () => {
  test("admin can update space info", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");

    const result = await checkWriteAuth(db, SPACE, ADMIN, {
      $type: "space.roomy.space.updateSpaceInfo.v0",
      id: newUlid(),
    });
    expect(result).toBeUndefined();
  });

  test("member cannot add admin", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.addAdmin.v0",
      id: newUlid(),
      userDid: OTHER,
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
  });
});

describe("auth/writeAuth — space member events", () => {
  test("joinSpace allows non-banned user", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    // No member edge, no ban

    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.joinSpace.v0",
      id: newUlid(),
    });
    expect(result).toBeUndefined();
  });

  test("joinSpace rejects banned user", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.joinSpace.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
  });

  test("leaveSpace requires membership", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);

    // Non-member cannot leave
    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.leaveSpace.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);

    // Member can leave
    await addEdge(db, SPACE, USER, "member");
    const result2 = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.leaveSpace.v0",
      id: newUlid(),
    });
    expect(result2).toBeUndefined();
  });

  test("updateProfile requires membership", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);

    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.user.updateProfile.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();

    await addEdge(db, SPACE, USER, "member");
    const result2 = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.user.updateProfile.v0",
      id: newUlid(),
    });
    expect(result2).toBeUndefined();
  });

  test("createInvite requires membership", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);

    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.createInvite.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();

    await addEdge(db, SPACE, USER, "member");
    const result2 = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.createInvite.v0",
      id: newUlid(),
    });
    expect(result2).toBeUndefined();
  });
});

describe("auth/writeAuth — bridged events", () => {
  test("admin can send bridged reaction", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");

    const result = await checkWriteAuth(db, SPACE, ADMIN, {
      $type: "space.roomy.reaction.addBridgedReaction.v0",
      id: newUlid(),
      reactionTo: newUlid(),
      reaction: "👍",
      reactingUser: USER,
    });
    expect(result).toBeUndefined();
  });

  test("member cannot send bridged reaction", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.reaction.addBridgedReaction.v0",
      id: newUlid(),
      reactionTo: newUlid(),
      reaction: "👍",
      reactingUser: OTHER,
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
  });
});

describe("auth/writeAuth — allow list coverage", () => {
  test("every allowed type is handled by a category", async () => {
    // Ensure no type falls through to the "unhandled" branch
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");
    await seedChannel(db, CHANNEL, SPACE, "readwrite");

    for (const $type of ALLOWED_TYPES) {
      const event: { $type: string; [k: string]: unknown } = {
        $type,
        id: newUlid(),
        room: CHANNEL, // for room events
      };
      // The result should never be the "unhandled" message
      const result = await checkWriteAuth(db, SPACE, ADMIN, event);
      if (result) {
        expect(result.message).not.toContain("Unhandled");
      }
    }
  });
});
