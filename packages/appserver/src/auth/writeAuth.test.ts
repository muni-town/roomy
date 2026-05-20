import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../db/db.ts";
import {
  checkWriteAuth,
  ALLOWED_TYPES,
  REJECTED_TYPES,
} from "./writeAuth.ts";
import { newUlid } from "@roomy-space/sdk";

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
}

const SPACE = "did:web:space.example";
const USER = "did:plc:alice";
const ADMIN = "did:plc:admin";
const OTHER = "did:plc:bob";
const CHANNEL = "01CHANNEL00000000000000000";
const ROLE = "01ROLE0000000000000000000";

// ── Seed helpers (same pattern as access.test.ts) ─────────────────────

function seedSpace(db: Database, spaceId = SPACE): void {
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    spaceId,
    spaceId,
  ]);
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
  test("personal.joinSpace is rejected with 400", () => {
    const db = freshDb();
    const result = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.personal.joinSpace.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
    expect(result!.error).toBe("InvalidRequest");
  });

  test("personal.leaveSpace is rejected with 400", () => {
    const db = freshDb();
    const result = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.personal.leaveSpace.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
  });

  test("markRead is rejected with 400", () => {
    const db = freshDb();
    const result = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.state.markRead.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
  });

  test("unknown type is rejected with 400", () => {
    const db = freshDb();
    const result = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.fake.event.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
    expect(result!.message).toContain("Unknown event type");
  });
});

describe("auth/writeAuth — room write events", () => {
  test("member can write to a readwrite room", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "readwrite");
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "member");

    const result = checkWriteAuth(
      db,
      SPACE,
      USER,
      createMessageEvent(CHANNEL),
    );
    expect(result).toBeUndefined();
  });

  test("non-member cannot write to a readwrite room", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "readwrite");
    seedUser(db, USER);
    // No member edge

    const result = checkWriteAuth(
      db,
      SPACE,
      USER,
      createMessageEvent(CHANNEL),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
  });

  test("admin can always write", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "none");
    seedUser(db, ADMIN);
    addEdge(db, SPACE, ADMIN, "admin");

    const result = checkWriteAuth(
      db,
      SPACE,
      ADMIN,
      createMessageEvent(CHANNEL),
    );
    expect(result).toBeUndefined();
  });

  test("banned user cannot write", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "readwrite");
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "member");
    db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    const result = checkWriteAuth(
      db,
      SPACE,
      USER,
      createMessageEvent(CHANNEL),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
  });

  test("missing room field returns 400", () => {
    const db = freshDb();
    const result = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.message.createMessage.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(400);
    expect(result!.message).toContain("room");
  });

  test("nonexistent room returns 404", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "member");

    const result = checkWriteAuth(
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
  function seedMessageWithAuthor(
    db: Database,
    messageId: string,
    roomId: string,
    authorDid: string,
  ) {
    db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      messageId,
      SPACE,
      roomId,
    ]);
    addEdge(db, messageId, authorDid, "author");
  }

  test("author can edit own message", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "readwrite");
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "member");
    const msgId = newUlid();
    seedMessageWithAuthor(db, msgId, CHANNEL, USER);

    const result = checkWriteAuth(
      db,
      SPACE,
      USER,
      editMessageEvent(CHANNEL, msgId),
    );
    expect(result).toBeUndefined();
  });

  test("non-author non-admin cannot edit message", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "readwrite");
    seedUser(db, USER);
    seedUser(db, OTHER);
    addEdge(db, SPACE, USER, "member");
    addEdge(db, SPACE, OTHER, "member");
    const msgId = newUlid();
    seedMessageWithAuthor(db, msgId, CHANNEL, USER);

    const result = checkWriteAuth(
      db,
      SPACE,
      OTHER,
      editMessageEvent(CHANNEL, msgId),
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
    expect(result!.message).toContain("author");
  });

  test("admin can edit anyone's message", () => {
    const db = freshDb();
    seedSpace(db);
    seedChannel(db, CHANNEL, SPACE, "readwrite");
    seedUser(db, USER);
    seedUser(db, ADMIN);
    addEdge(db, SPACE, ADMIN, "admin");
    const msgId = newUlid();
    seedMessageWithAuthor(db, msgId, CHANNEL, USER);

    const result = checkWriteAuth(
      db,
      SPACE,
      ADMIN,
      deleteMessageEvent(CHANNEL, msgId),
    );
    expect(result).toBeUndefined();
  });
});

describe("auth/writeAuth — room manage events", () => {
  test("admin can create room", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, ADMIN);
    addEdge(db, SPACE, ADMIN, "admin");

    const result = checkWriteAuth(db, SPACE, ADMIN, {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.channel",
    });
    expect(result).toBeUndefined();
  });

  test("member cannot create room", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "member");

    const result = checkWriteAuth(db, SPACE, USER, {
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
  test("admin can update space info", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, ADMIN);
    addEdge(db, SPACE, ADMIN, "admin");

    const result = checkWriteAuth(db, SPACE, ADMIN, {
      $type: "space.roomy.space.updateSpaceInfo.v0",
      id: newUlid(),
    });
    expect(result).toBeUndefined();
  });

  test("member cannot add admin", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "member");

    const result = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.addAdmin.v0",
      id: newUlid(),
      userDid: OTHER,
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
  });
});

describe("auth/writeAuth — space member events", () => {
  test("joinSpace allows non-banned user", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);
    // No member edge, no ban

    const result = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.joinSpace.v0",
      id: newUlid(),
    });
    expect(result).toBeUndefined();
  });

  test("joinSpace rejects banned user", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);
    db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    const result = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.joinSpace.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
  });

  test("leaveSpace requires membership", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);

    // Non-member cannot leave
    const result = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.leaveSpace.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);

    // Member can leave
    addEdge(db, SPACE, USER, "member");
    const result2 = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.leaveSpace.v0",
      id: newUlid(),
    });
    expect(result2).toBeUndefined();
  });

  test("updateProfile requires membership", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);

    const result = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.user.updateProfile.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();

    addEdge(db, SPACE, USER, "member");
    const result2 = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.user.updateProfile.v0",
      id: newUlid(),
    });
    expect(result2).toBeUndefined();
  });

  test("createInvite requires membership", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);

    const result = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.createInvite.v0",
      id: newUlid(),
    });
    expect(result).toBeDefined();

    addEdge(db, SPACE, USER, "member");
    const result2 = checkWriteAuth(db, SPACE, USER, {
      $type: "space.roomy.space.createInvite.v0",
      id: newUlid(),
    });
    expect(result2).toBeUndefined();
  });
});

describe("auth/writeAuth — bridged events", () => {
  test("admin can send bridged reaction", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, ADMIN);
    addEdge(db, SPACE, ADMIN, "admin");

    const result = checkWriteAuth(db, SPACE, ADMIN, {
      $type: "space.roomy.reaction.addBridgedReaction.v0",
      id: newUlid(),
      reactionTo: newUlid(),
      reaction: "👍",
      reactingUser: USER,
    });
    expect(result).toBeUndefined();
  });

  test("member cannot send bridged reaction", () => {
    const db = freshDb();
    seedSpace(db);
    seedUser(db, USER);
    addEdge(db, SPACE, USER, "member");

    const result = checkWriteAuth(db, SPACE, USER, {
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
  test("every allowed type is handled by a category", () => {
    // Ensure no type falls through to the "unhandled" branch
    const db = freshDb();
    seedSpace(db);
    seedUser(db, ADMIN);
    addEdge(db, SPACE, ADMIN, "admin");
    seedChannel(db, CHANNEL, SPACE, "readwrite");

    for (const $type of ALLOWED_TYPES) {
      const event: { $type: string; [k: string]: unknown } = {
        $type,
        id: newUlid(),
        room: CHANNEL, // for room events
      };
      // The result should never be the "unhandled" message
      const result = checkWriteAuth(db, SPACE, ADMIN, event);
      if (result) {
        expect(result.message).not.toContain("Unhandled");
      }
    }
  });
});
