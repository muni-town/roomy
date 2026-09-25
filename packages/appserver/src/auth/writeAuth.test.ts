import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbLike } from "../db/types.ts";
import {
  checkWriteAuth,
  prewarmWriteAuthAccess,
  ALLOWED_TYPES,
  REJECTED_TYPES,
  type WriteAuthResult,
} from "./writeAuth.ts";
import { createAccessMemo, spaceAccess, type SpaceAccess } from "./access.ts";
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

describe("auth/writeAuth — moveMessages is admin-only", () => {
  /** A move event with `room` as the source and `toRoomId` the destination. */
  function moveEvent(sourceRoomId: string, destRoomId: string) {
    return {
      id: newUlid(),
      $type: "space.roomy.message.moveMessages.v0",
      room: sourceRoomId,
      messageIds: [newUlid()],
      toRoomId: destRoomId,
    };
  }

  test("an ordinary room-writer cannot move a message", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    const DEST = newUlid();
    await seedChannel(db, DEST, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(db, SPACE, USER, moveEvent(CHANNEL, DEST));
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
    expect(result!.message).toContain("admin");
  });

  test("a space admin can move a message", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    const DEST = newUlid();
    await seedChannel(db, DEST, SPACE, "readwrite");
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");

    const result = await checkWriteAuth(db, SPACE, ADMIN, moveEvent(CHANNEL, DEST));
    expect(result).toBeUndefined();
  });

  test("an admin cannot move into a room that does not exist", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");

    const result = await checkWriteAuth(
      db,
      SPACE,
      ADMIN,
      moveEvent(CHANNEL, "01MISSINGDEST0000000000000"),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(404);
  });

  test("an admin cannot move a message into another space's room", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    // A room owned by a different stream (space).
    const FOREIGN_SPACE = "did:web:other-space.example";
    const FOREIGN_ROOM = newUlid();
    await db.run("insert into entities (id, stream_id) values (?, ?)", [
      FOREIGN_ROOM,
      FOREIGN_SPACE,
    ]);
    await db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [FOREIGN_ROOM],
    );
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");

    const result = await checkWriteAuth(
      db,
      SPACE,
      ADMIN,
      moveEvent(CHANNEL, FOREIGN_ROOM),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
    expect(result!.message).toContain("not in this space");
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

  test("member cannot create channel room", async () => {
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

  test("member can create thread room", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.thread",
    });
    expect(result).toBeUndefined();
  });

  test("admin can create thread room", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");

    const result = await checkWriteAuth(db, SPACE, ADMIN, {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.thread",
    });
    expect(result).toBeUndefined();
  });

  test("non-member cannot create thread room", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    // No member edge

    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.thread",
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
    expect(result!.message).toContain("not a member");
  });

  test("banned member cannot create thread room", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    await db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.thread",
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
    expect(result!.message).toContain("banned");
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

  test("admin can update sidebar", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");

    const result = await checkWriteAuth(db, SPACE, ADMIN, {
      $type: "space.roomy.space.updateSidebar.v1",
      id: newUlid(),
      categories: [],
    });
    expect(result).toBeUndefined();
  });

  test("member cannot update sidebar", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.updateSidebar.v1",
      id: newUlid(),
      categories: [],
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
    expect(result!.message).toContain("admin");
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

describe("auth/writeAuth — service self-write", () => {
  const SERVICE = "did:web:api.roomy.space";

  /** A space the service DID has no edge of any kind in. */
  async function seedStrandedSpace(db: DbLike): Promise<void> {
    await seedSpace(db);
    await seedUser(db, SERVICE);
  }

  test("service DID may grant a role without membership or admin", async () => {
    const { asyncDb: db } = freshDb();
    await seedStrandedSpace(db);

    const result = await checkWriteAuth(db, SPACE, SERVICE, { $type: "space.roomy.role.addMemberRole.v0", id: newUlid(), userDid: USER, roleId: ROLE }, { serviceDid: SERVICE });
    expect(result).toBeUndefined();
  });

  test("service DID may revoke a role without membership or admin", async () => {
    const { asyncDb: db } = freshDb();
    await seedStrandedSpace(db);

    const result = await checkWriteAuth(db, SPACE, SERVICE, { $type: "space.roomy.role.removeMemberRole.v0", id: newUlid(), userDid: USER, roleId: ROLE }, { serviceDid: SERVICE });
    expect(result).toBeUndefined();
  });

  test("service DID may self-write even while banned in the space", async () => {
    const { asyncDb: db } = freshDb();
    await seedStrandedSpace(db);
    await db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      SERVICE,
    ]);

    const result = await checkWriteAuth(db, SPACE, SERVICE, { $type: "space.roomy.role.addMemberRole.v0", id: newUlid(), userDid: USER, roleId: ROLE }, { serviceDid: SERVICE });
    expect(result).toBeUndefined();
  });

  test("the relaxation covers only role grants — not admin or ban events", async () => {
    const { asyncDb: db } = freshDb();
    await seedStrandedSpace(db);

    for (const $type of [
      "space.roomy.space.addAdmin.v0",
      "space.roomy.space.removeAdmin.v0",
      "space.roomy.space.banAccount.v0",
    ]) {
      const result = await checkWriteAuth(db, SPACE, SERVICE, { $type, id: newUlid(), userDid: USER }, { serviceDid: SERVICE });
      expect(result?.status).toBe(403);
    }
  });

  test("a DID that is not the configured service DID gets no self-write", async () => {
    const { asyncDb: db } = freshDb();
    await seedStrandedSpace(db);
    await seedUser(db, OTHER);

    const result = await checkWriteAuth(db, SPACE, OTHER, { $type: "space.roomy.role.addMemberRole.v0", id: newUlid(), userDid: USER, roleId: ROLE }, { serviceDid: SERVICE });
    expect(result?.status).toBe(403);
  });

  test("without a configured service DID the rule is inert", async () => {
    const { asyncDb: db } = freshDb();
    await seedStrandedSpace(db);

    const result = await checkWriteAuth(
      db,
      SPACE,
      SERVICE,
      { $type: "space.roomy.role.addMemberRole.v0", id: newUlid(), userDid: USER, roleId: ROLE },
    );
    expect(result?.status).toBe(403);
  });
});

describe("auth/writeAuth — reply targets must be messages", () => {
  /** A createMessage carrying a single reply attachment at `target`. */
  function replyEvent(roomId: string, target: string) {
    return {
      id: newUlid(),
      $type: "space.roomy.message.createMessage.v0",
      room: roomId,
      body: { mimeType: "text/plain", data: "hi" },
      extensions: {
        "space.roomy.extension.attachments.v0": {
          $type: "space.roomy.extension.attachments.v0",
          attachments: [
            { $type: "space.roomy.attachment.reply.v0", target },
          ],
        },
      },
    };
  }

  /** A message entity: an entity carrying a `room`. */
  async function seedMessage(
    db: DbLike,
    messageId: string,
    roomId: string,
  ): Promise<void> {
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [messageId, SPACE, roomId],
    );
  }

  test("a reply to another message is allowed", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    const target = newUlid();
    await seedMessage(db, target, CHANNEL);

    const result = await checkWriteAuth(
      db,
      SPACE,
      USER,
      replyEvent(CHANNEL, target),
    );
    expect(result).toBeUndefined();
  });

  test("a reply to a message in another room is allowed", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    const OTHER_ROOM = newUlid();
    await seedChannel(db, OTHER_ROOM, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    const target = newUlid();
    await seedMessage(db, target, OTHER_ROOM);

    const result = await checkWriteAuth(
      db,
      SPACE,
      USER,
      replyEvent(CHANNEL, target),
    );
    expect(result).toBeUndefined();
  });

  // The production signature this fixes: a message whose reply target is the
  // room it lives in. `getMessage` resolves such a target as a message and
  // 400s ("is not a message (no room)"), so the reply preview refetches a
  // permanent failure. Nothing rejected it at write time before this check.
  test("a reply targeting the room itself is rejected with 400", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(
      db,
      SPACE,
      USER,
      replyEvent(CHANNEL, CHANNEL),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
    expect(result!.message).toContain("is not a message");
  });

  test("a reply targeting a user entity is rejected with 400", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(
      db,
      SPACE,
      USER,
      replyEvent(CHANNEL, USER),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
  });

  test("a reply targeting a nonexistent entity is rejected with 400", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(
      db,
      SPACE,
      USER,
      replyEvent(CHANNEL, "01NOTAMESSAGE0000000000000"),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
    expect(result!.message).toContain("is not a message");
  });

  test("editMessage replacing attachments with a bad reply target is rejected", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    const messageId = newUlid();
    await seedMessage(db, messageId, CHANNEL);
    await addEdge(db, messageId, USER, "author");

    const result = await checkWriteAuth(db, SPACE, USER, {
      ...replyEvent(CHANNEL, CHANNEL),
      $type: "space.roomy.message.editMessage.v0",
      messageId,
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
  });

  test("attachments with no reply still pass", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");

    const result = await checkWriteAuth(db, SPACE, USER, {
      id: newUlid(),
      $type: "space.roomy.message.createMessage.v0",
      room: CHANNEL,
      body: { mimeType: "text/plain", data: "hi" },
      extensions: {
        "space.roomy.extension.attachments.v0": {
          $type: "space.roomy.extension.attachments.v0",
          attachments: [{ $type: "space.roomy.attachment.link.v0", uri: "https://x.test" }],
        },
      },
    });
    expect(result).toBeUndefined();
  });
});

// ── Batched authorization (the sendEvents N+1) ────────────────────────────

/**
 * Wrap a handle so every `query` call is counted. The authorize path only
 * reads, so counting `query` counts its SQL statements.
 */
function countQueries(db: DbLike): { db: DbLike; count: () => number } {
  let n = 0;
  const wrapped = new Proxy(db, {
    get(target, prop, recv) {
      if (prop !== "query") return Reflect.get(target, prop, recv);
      return (...args: unknown[]) => {
        n++;
        return (Reflect.get(target, prop, recv) as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
      };
    },
  });
  return { db: wrapped, count: () => n };
}

/**
 * Authorize `events` the way `sendEvents` does — one context, one access memo,
 * one batched prewarm — against a counting handle, and return the statements
 * spent. Seeding is deliberately outside the count.
 */
async function authorizeBatch(
  rawDb: DbLike,
  events: Array<{ id: string; $type: string; room: string; body: unknown; extensions: unknown }>,
  did: string,
  access: SpaceAccess,
): Promise<{ statements: number; denial: WriteAuthResult }> {
  const { db, count } = countQueries(rawDb);
  const accessMemo = createAccessMemo();
  await prewarmWriteAuthAccess(db, events as never, did, accessMemo);
  let denial: WriteAuthResult;
  for (const event of events) {
    denial = await checkWriteAuth(db, SPACE, did, event as never, {
      access,
      accessMemo,
    });
    if (denial) return { statements: count(), denial };
  }
  return { statements: count(), denial: undefined };
}

describe("auth/writeAuth — batched authorization", () => {
  /**
   * The `sendEvents.authorize` N+1: a batch of N messages to one room used to
   * re-resolve that room (and the caller's space standing) once per event —
   * ~7 SQL statements each, measured in docs/sendevents-write-path-review.md
   * as the 11.5 s authorize span under load. Authorizing through one memo
   * must cost a constant, not N × constant.
   */
  test("a batch to one room does not cost a room resolution per event", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    await seedUser(db, USER);
    await addEdge(db, SPACE, USER, "member");
    const access = await spaceAccess(db, SPACE, USER);

    const small = await authorizeBatch(
      db,
      Array.from({ length: 5 }, () => createMessageEvent(CHANNEL)),
      USER,
      access,
    );
    const big = await authorizeBatch(
      db,
      Array.from({ length: 50 }, () => createMessageEvent(CHANNEL)),
      USER,
      access,
    );

    expect(small.denial).toBeUndefined();
    expect(big.denial).toBeUndefined();
    // Ten times the events, no meaningful extra SQL. The pre-fix cost was
    // ~7 statements *per event*, so this assertion fails on the old path by
    // two orders of magnitude.
    expect(big.statements - small.statements).toBeLessThanOrEqual(2);
    expect(big.statements).toBeLessThan(20);
  });

  test("the batched path denies exactly what the isolated path denies", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "none");
    await seedUser(db, OTHER);
    const access = await spaceAccess(db, SPACE, OTHER);

    const batched = await authorizeBatch(
      db,
      Array.from({ length: 3 }, () => createMessageEvent(CHANNEL)),
      OTHER,
      access,
    );
    const isolated = await checkWriteAuth(db, SPACE, OTHER, createMessageEvent(CHANNEL), {
      access,
    });

    expect(batched.denial).toEqual(isolated);
    expect(batched.denial?.status).toBe(403);
  });

  /**
   * moveMessages authorizes a *destination* room through `toRoomId`, which is
   * not the `room` field. The prewarm must collect it too, or that event's
   * check silently keeps its own round-trips.
   */
  test("a moveMessages destination is prewarmed, not resolved on demand", async () => {
    const { asyncDb: db } = freshDb();
    await seedSpace(db);
    await seedChannel(db, CHANNEL, SPACE, "readwrite");
    const DEST = newUlid();
    await seedChannel(db, DEST, SPACE, "readwrite");
    await seedUser(db, ADMIN);
    await addEdge(db, SPACE, ADMIN, "admin");
    const access = await spaceAccess(db, SPACE, ADMIN);

    const moveEvents = (n: number) =>
      Array.from({ length: n }, () => ({
        id: newUlid(),
        $type: "space.roomy.message.moveMessages.v0",
        room: CHANNEL,
        toRoomId: DEST,
      }));

    const { db: counting, count } = countQueries(db);
    const accessMemo = createAccessMemo();
    const events = moveEvents(20);
    await prewarmWriteAuthAccess(counting, events as never, ADMIN, accessMemo);
    const afterPrewarm = count();
    for (const event of events) {
      await checkWriteAuth(counting, SPACE, ADMIN, event as never, { access, accessMemo });
    }

    // Both rooms resolved by the prewarm; the loop adds nothing.
    expect(count() - afterPrewarm).toBe(0);
  });
});
