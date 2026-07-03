/**
 * Tests for inferSignals — the pure event → signal mapping.
 *
 * Each test constructs an AppliedEvent and asserts the signals produced.
 * We test the interesting event types (those with non-trivial invalidation
 * logic). Simple pass-through handlers are covered implicitly.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamDid, UserDid, Ulid, EventType } from "@roomy-space/sdk";
import { type, schemas } from "@roomy-space/sdk";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { inferSignals } from "./inferSignals.ts";
import type {
  AppliedEvent,
  InvalidationEvent,
  QueryInvalidation,
  QueryNsid,
} from "./types.ts";
import type { DbLike } from "../db/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

// ─── Helpers ────────────────────────────────────────────────────────────

const STREAM_DID = "did:web:space.example.com" as StreamDid;
const USER_DID = "did:plc:alice" as UserDid;
const ROOM_ID = "01HXSXKBQ4TESTROOM000000000" as Ulid;
const EVENT_ID = "01HXSXKBQ4TESTEVENT000000001" as Ulid;
const SPACE_ID = STREAM_DID; // For space-level events, streamDid === spaceId.

function makeEvent(
  overrides: Partial<AppliedEvent> & { type: EventType },
): AppliedEvent {
  return {
    streamDid: STREAM_DID,
    user: USER_DID,
    id: EVENT_ID,
    ...overrides,
  };
}

/** Collect just the query invalidation NSIDs from a list of signals. */
function invalidatedNsids(signals: InvalidationEvent[]): QueryNsid[] {
  return signals
    .filter(
      (s): s is { kind: "queryInvalidation"; signal: QueryInvalidation } =>
        s.kind === "queryInvalidation",
    )
    .map((s) => s.signal.nsid);
}

function findMessageDiff(signals: InvalidationEvent[]) {
  return signals.find((s) => s.kind === "messageDiff");
}
/**
 * Materialize a message into a fresh in-memory DB and return a DbLike
 * so `inferSignals` can read the materialized row.
 *
 * `handleCreateMessage` / `handleEditMessage` build the #messageDiff payload
 * via `selectMessages`, which reads back the materialized row — so the row
 * must exist before `inferSignals` runs (as it does in production, where the
 * event is applied to SQLite first).
 */
function seedMessageDb(opts: {
  id: string;
  roomId: string;
  authorDid: string;
  authorName: string;
  content: string;
}): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [SCHEMA_VERSION]);
  const ts = Date.parse("2026-05-08T12:00:00Z");

  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
    opts.authorDid,
    opts.authorDid,
  ]);
  db.run(
    "insert or ignore into comp_info (entity, name, avatar) values (?, ?, ?)",
    [opts.authorDid, opts.authorName, null],
  );
  db.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [opts.id, STREAM_DID, opts.roomId, opts.id],
  );
  db.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) " +
      "values (?, 'text/plain', ?, ?, ?)",
    [opts.id, Buffer.from(opts.content), opts.id, ts],
  );
  db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    opts.id,
    opts.authorDid,
  ]);
  return { db, asyncDb: toAsyncDb(db) };
}

// ─── Message events ─────────────────────────────────────────────────────

describe("inferSignals: message events", () => {
  it("createMessage produces a messageDiff + room/space invalidation", async () => {
    const { asyncDb } = seedMessageDb({
      id: EVENT_ID,
      roomId: ROOM_ID,
      authorDid: USER_DID,
      authorName: "Alice",
      content: "hello",
    });

    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.createMessage.v0",
        roomId: ROOM_ID,
        details: {
          content: "hello",
          authorName: "Alice",
          timestamp: "2026-05-08T12:00:00Z",
        },
      }),
      asyncDb,
    );

    const diff = findMessageDiff(signals);
    expect(diff).toBeDefined();
    expect(diff!.kind).toBe("messageDiff");
    if (diff!.kind === "messageDiff") {
      expect(diff!.signal.roomId).toBe(ROOM_ID);
      expect(diff!.signal.ops).toHaveLength(1);
      const op = diff!.signal.ops[0]!;
      expect(op.op).toBe("add");
      expect(op.key).toBe(EVENT_ID);
      if (op.op === "add") {
        expect(op.message).toEqual(
          expect.objectContaining({
            id: EVENT_ID,
            content: "hello",
            authorDid: USER_DID,
          }),
        );
        // The diff payload MUST satisfy the SDK `Message` schema — the client
        // SyncRouter validates the #messageDiff frame and silently drops it
        // if any required field (forwardedFrom, media, tags) is missing.
        const validated = schemas.queries.getMessages.Message(op.message);
        expect(validated instanceof type.errors).toBe(false);
      }
      // seq is 0 here — it's only assigned by the Router when dispatching.
      // inferSignals returns the raw signal without seq assignment.
      expect(diff!.signal.seq).toBe(0);
    }

    // Also invalidates room metadata and space metadata (unread counts).
    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.room.getMetadata");
    expect(nsids).toContain("space.roomy.space.getMetadata");
  });

  it("createMessage without roomId produces no signals", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.createMessage.v0",
      }),
    );
    expect(signals).toHaveLength(0);
  });
  it("editMessage produces a messageDiff update keyed by messageId, not the edit event id", async () => {
    const MESSAGE_ID = "01HXSXKBQ4TESTMSG00000000A" as Ulid;
    const EDIT_EVENT_ID = "01HXSXKBQ4TESTEDIT0000000B" as Ulid;

    const { asyncDb } = seedMessageDb({
      id: MESSAGE_ID,
      roomId: ROOM_ID,
      authorDid: USER_DID,
      authorName: "Alice",
      content: "edited",
    });

    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.editMessage.v0",
        id: EDIT_EVENT_ID,
        roomId: ROOM_ID,
        details: {
          messageId: MESSAGE_ID,
          content: "edited",
          authorDid: USER_DID,
          authorName: "Alice",
          timestamp: "2026-05-08T12:00:00Z",
        },
      }),
      asyncDb,
    );

    const diff = findMessageDiff(signals);
    expect(diff).toBeDefined();
    if (diff!.kind === "messageDiff") {
      const op = diff!.signal.ops[0]!;
      expect(op.op).toBe("update");
      // The diff MUST be keyed by the message id, not the edit event id.
      expect(op.key).toBe(MESSAGE_ID);
      expect(op.key).not.toBe(EDIT_EVENT_ID);
      if (op.op === "update") {
        expect(op.message.id).toBe(MESSAGE_ID);
        expect(op.message.content).toBe("edited");
        const validated = schemas.queries.getMessages.Message(op.message);
        expect(validated instanceof type.errors).toBe(false);
      }
    }

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.room.getMetadata");
    // editMessage should NOT invalidate space-level queries (no unread change).
    expect(nsids).not.toContain("space.roomy.space.getMetadata");
  });

  it("deleteMessage produces a remove diff keyed by messageId + room/space invalidation", async () => {
    const MESSAGE_ID = "01HXSXKBQ4TESTMSG00000000A" as Ulid;
    const DELETE_EVENT_ID = "01HXSXKBQ4TESTDEL000000000B" as Ulid;

    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.deleteMessage.v0",
        id: DELETE_EVENT_ID,
        roomId: ROOM_ID,
        details: { messageId: MESSAGE_ID },
      }),
    );

    const diff = findMessageDiff(signals);
    expect(diff).toBeDefined();
    if (diff!.kind === "messageDiff") {
      // The remove op MUST be keyed by the message id, not the delete event
      // id, so the client can match and drop the right cache entry.
      expect(diff!.signal.ops[0]).toEqual({ op: "remove", key: MESSAGE_ID });
      expect(diff!.signal.ops[0]!.key).not.toBe(DELETE_EVENT_ID);
    }

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.room.getMetadata");
    expect(nsids).toContain("space.roomy.space.getMetadata");
  });
});

// ─── Reaction events ────────────────────────────────────────────────────

describe("inferSignals: reaction events", () => {
  it("addReaction invalidates room messages and the specific message", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.reaction.addReaction.v0",
        roomId: ROOM_ID,
        details: { messageId: "msg123" },
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.room.getMessages");
    expect(nsids).toContain("space.roomy.message.getMessage");
    // A reaction on a room's latest message must refresh the activity feed
    // (the feed renders reactions on the latest message). Emitted with no
    // params so the client prefix-matches every activity-feed query key.
    expect(nsids).toContain("space.roomy.space.getActivityFeed");
    const feedSignal = signals.find(
      (s) =>
        s.kind === "queryInvalidation" &&
        s.signal.nsid === "space.roomy.space.getActivityFeed",
    );
    expect(feedSignal).toBeDefined();
    expect(
      feedSignal &&
        Object.keys(
          (feedSignal as { signal: { params: Record<string, string> } }).signal.params,
        ).length,
    ).toBe(0);
  });

  it("removeReaction does the same", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.reaction.removeReaction.v0",
        roomId: ROOM_ID,
        details: { messageId: "msg123" },
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.room.getMessages");
    expect(nsids).toContain("space.roomy.space.getActivityFeed");
  });
});

// ─── Room events ────────────────────────────────────────────────────────

describe("inferSignals: room events", () => {
  it("createRoom invalidates space-level queries", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.room.createRoom.v0",
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.space.getMetadata");
    expect(nsids).toContain("space.roomy.space.getSpaces");
    expect(nsids).toContain("space.roomy.space.getThreads");
    expect(nsids).toContain("space.roomy.space.getMembers");
  });

  it("updateRoom with roomId invalidates room + space", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.room.updateRoom.v0",
        roomId: ROOM_ID,
        details: { roomId: ROOM_ID },
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.room.getMetadata");
    expect(nsids).toContain("space.roomy.space.getMetadata");
  });
});

// ─── Space events ───────────────────────────────────────────────────────

describe("inferSignals: space events", () => {
  it("updateSpaceInfo invalidates metadata + spaces list", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.space.updateSpaceInfo.v0",
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.space.getMetadata");
    expect(nsids).toContain("space.roomy.space.getSpaces");
  });

  it("updateSidebar invalidates only metadata (sidebar is part of it)", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.space.updateSidebar.v1",
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.space.getMetadata");
    expect(nsids).toHaveLength(1);
  });

  it("joinSpace invalidates space queries + the joining user's space list", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.space.joinSpace.v0",
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.space.getMembers");

    // The joining user's getSpaces should be invalidated.
    const userScoped = signals.filter(
      (s): s is { kind: "queryInvalidation"; signal: QueryInvalidation } =>
        s.kind === "queryInvalidation" &&
        s.signal.nsid === "space.roomy.space.getSpaces",
    );
    expect(userScoped.some((s) => s.signal.affectedUser === USER_DID)).toBe(
      true,
    );
  });

  it("addAdmin invalidates space queries + target user's view", async () => {
    const targetDid = "did:plc:bob" as import("@roomy-space/sdk").UserDid;
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.space.addAdmin.v0",
        details: { userDid: targetDid },
      }),
    );

    const userScoped = signals.filter(
      (s): s is { kind: "queryInvalidation"; signal: QueryInvalidation } =>
        s.kind === "queryInvalidation" && s.signal.affectedUser === targetDid,
    );
    expect(userScoped.length).toBeGreaterThan(0);
    const userNsids = userScoped.map((s) => s.signal.nsid);
    expect(userNsids).toContain("space.roomy.space.getSpaces");
    expect(userNsids).toContain("space.roomy.space.getMetadata");
  });
});

// ─── Role events ────────────────────────────────────────────────────────

describe("inferSignals: role events", () => {
  it("createRole only invalidates getRoles", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.role.createRole.v0",
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toEqual(["space.roomy.space.getRoles"]);
  });

  it("deleteRole invalidates roles + space metadata (permissions may have changed)", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.role.deleteRole.v0",
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.space.getRoles");
    expect(nsids).toContain("space.roomy.space.getMetadata");
  });

  it("addMemberRole invalidates roles + members + affected user's view", async () => {
    const targetDid = "did:plc:carol" as import("@roomy-space/sdk").UserDid;
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.role.addMemberRole.v0",
        details: { userDid: targetDid },
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.space.getRoles");
    expect(nsids).toContain("space.roomy.space.getMembers");

    const userScoped = signals.filter(
      (s): s is { kind: "queryInvalidation"; signal: QueryInvalidation } =>
        s.kind === "queryInvalidation" && s.signal.affectedUser === targetDid,
    );
    expect(userScoped.length).toBeGreaterThan(0);
  });

  it("setRoleRoomPermission invalidates roles + room + space", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.role.setRoleRoomPermission.v0",
        details: { roomId: ROOM_ID },
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.space.getRoles");
    expect(nsids).toContain("space.roomy.room.getMetadata");
    expect(nsids).toContain("space.roomy.space.getMetadata");
  });
});

// ─── Invite events ──────────────────────────────────────────────────────

describe("inferSignals: invite events", () => {
  it("createInvite invalidates only getInvites", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.space.createInvite.v0",
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toEqual(["space.roomy.space.getInvites"]);
  });
});

// ─── Personal stream events ─────────────────────────────────────────────

describe("inferSignals: personal stream events", () => {
  it("personalJoinSpace invalidates user's space list + target space members", async () => {
    const targetSpace =
      "did:web:target.space" as import("@roomy-space/sdk").StreamDid;
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.space.personal.joinSpace.v0",
        details: { spaceDid: targetSpace },
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.space.getSpaces");

    // Space-scoped invalidations use the personal stream's DID, not the
    // target space DID. The personal stream's streamDid is the user's own.
    // But we pass targetSpace in details, so the getMembers invalidation
    // should target the joined space.
    const memberInvalidations = signals.filter(
      (s): s is { kind: "queryInvalidation"; signal: QueryInvalidation } =>
        s.kind === "queryInvalidation" &&
        s.signal.nsid === "space.roomy.space.getMembers",
    );
    expect(
      memberInvalidations.some((s) => s.signal.params.spaceId === targetSpace),
    ).toBe(true);
  });
});

// ─── State events ───────────────────────────────────────────────────────

describe("inferSignals: state events", () => {
  it("markRead invalidates room + space only for the reading user", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.state.markRead.v0",
        roomId: ROOM_ID,
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.room.getMetadata");
    expect(nsids).toContain("space.roomy.space.getMetadata");
    expect(nsids).toContain("space.roomy.space.getSpaces");

    // All invalidations should be scoped to the reading user.
    const unscoped = signals.filter(
      (s): s is { kind: "queryInvalidation"; signal: QueryInvalidation } =>
        s.kind === "queryInvalidation" && s.signal.affectedUser === undefined,
    );
    expect(unscoped).toHaveLength(0);
  });
});

// ─── Link events ────────────────────────────────────────────────────────

describe("inferSignals: link events", () => {
  it("createRoomLink invalidates room + space threads + space metadata", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.link.createRoomLink.v0",
        roomId: ROOM_ID,
      }),
    );

    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.room.getMetadata");
    expect(nsids).toContain("space.roomy.space.getMetadata");
    expect(nsids).toContain("space.roomy.space.getThreads");
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────

describe("inferSignals: edge cases", () => {
  it("synthetic events produce no signals", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.query.spaceMeta.v0" as EventType,
      }),
    );
    expect(signals).toHaveLength(0);
  });

  it("unknown event types produce no signals", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.unknown.futureEvent.v0" as EventType,
      }),
    );
    expect(signals).toHaveLength(0);
  });

  it("page edit produces no signals (out of scope)", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.page.editPage.v0",
      }),
    );
    expect(signals).toHaveLength(0);
  });
});
