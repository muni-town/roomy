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
import type { MessageDto } from "../queries/selectMessages.ts";
import type {
  AppliedEvent,
  InvalidationEvent,
  QueryInvalidation,
  QueryNsid,
  RoomMetadataDiff,
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

function findRoomMetadataDiff(signals: InvalidationEvent[]) {
  return signals.find((s) => s.kind === "roomMetadataDiff");
}

function findMentionDiffs(signals: InvalidationEvent[]) {
  return signals.filter((s) => s.kind === "mentionDiff");
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
  // Attach readstate schema (handleCreateMessage reads read_positions).
  db.exec("attach database ':memory:' as readstate");
  db.exec(
    "create table if not exists readstate.read_positions (user_did text not null, room_id text not null, seen_up_to text not null, unread_count integer not null default 0, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict",
  );
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
  it("createMessage produces a messageDiff + roomMetadataDiff + room/space invalidation", async () => {
    const { db, asyncDb } = seedMessageDb({
      id: EVENT_ID,
      roomId: ROOM_ID,
      authorDid: USER_DID,
      authorName: "Alice",
      content: "hello",
    });
    // Seed a read_positions row so getRoomUnreadCounts has a user to report.
    // In production the materializer bumps unread_count before inferSignals
    // runs; here we pre-seed the row to simulate that.
    db.run(
      "insert into readstate.read_positions (user_did, room_id, seen_up_to, unread_count) values (?, ?, ?, ?)",
      [USER_DID, ROOM_ID, "0", 1],
    );

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

    // roomMetadataDiff carries the delta and the affected user set. The
    // message-create path replaces the broad getSpaces broadcast with
    // this targeted diff.
    const roomDiff = findRoomMetadataDiff(signals);
    expect(roomDiff).toBeDefined();
    if (roomDiff!.kind === "roomMetadataDiff") {
      expect(roomDiff!.signal.spaceId).toBe(STREAM_DID);
      expect(roomDiff!.signal.roomId).toBe(ROOM_ID);
      expect(roomDiff!.signal.delta).toBe(1);
      expect(roomDiff!.signal.users).toHaveLength(1);
      expect(roomDiff!.signal.users[0]).toBe(USER_DID);
      // The seeded read_positions row has unread_count = 1 (the +1 bump
      // already applied), so the user became newly-unread: the channel
      // room-count delta is +1 for them.
      expect(roomDiff!.signal.roomUnreadDeltas?.get(USER_DID)).toBe(1);
      expect(roomDiff!.signal.threadUnreadDeltas).toBeUndefined();
    }

    // Still invalidates room metadata (recentThreads) and space metadata
    // (author's activeThreads). The getSpaces broadcast is gone — the
    // roomMetadataDiff handles the unread-count patch instead.
    const nsids = invalidatedNsids(signals);
    expect(nsids).toContain("space.roomy.space.getThreads");
    expect(nsids).toContain("space.roomy.room.getMetadata");
    expect(nsids).toContain("space.roomy.room.getThreads");
    expect(nsids).toContain("space.roomy.space.getMetadata");
    expect(nsids).not.toContain("space.roomy.space.getSpaces");
  });

  it("createMessage uses a pre-fetched messageSnapshots map and skips the DB read", async () => {
    // Seed a DB whose content is "from-db" but pass a snapshot map whose
    // content is "from-snapshot". The diff MUST carry the snapshot's
    // content — proving the handler used the map and did not read the DB.
    const { asyncDb } = seedMessageDb({
      id: EVENT_ID,
      roomId: ROOM_ID,
      authorDid: USER_DID,
      authorName: "Alice",
      content: "from-db",
    });
    const snapshot: MessageDto = {
      id: EVENT_ID,
      content: "from-snapshot",
      authorDid: USER_DID,
      authorName: "Alice",
      timestamp: "2026-05-08T12:00:00Z",
      reactions: [],
      media: [],
      linkEmbeds: [],
    };
    const snapshots = new Map([[EVENT_ID, snapshot]]);

    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.createMessage.v0",
        roomId: ROOM_ID,
      }),
      asyncDb,
      snapshots,
    );

    const diff = findMessageDiff(signals);
    expect(diff).toBeDefined();
    if (diff!.kind === "messageDiff") {
      const op = diff!.signal.ops[0]!;
      expect(op.op).toBe("add");
      if (op.op === "add") {
        expect(op.message.content).toBe("from-snapshot");
      }
    }
  });

  it("createMessage falls back to a DB read when the snapshot map has no entry for the id", async () => {
    const { asyncDb } = seedMessageDb({
      id: EVENT_ID,
      roomId: ROOM_ID,
      authorDid: USER_DID,
      authorName: "Alice",
      content: "from-db",
    });
    // Empty snapshot map — handler must fall back to reading the DB.
    const snapshots = new Map<Ulid, MessageDto>();

    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.createMessage.v0",
        roomId: ROOM_ID,
      }),
      asyncDb,
      snapshots,
    );

    const diff = findMessageDiff(signals);
    expect(diff).toBeDefined();
    if (diff!.kind === "messageDiff") {
      const op = diff!.signal.ops[0]!;
      expect(op.op).toBe("add");
      if (op.op === "add") {
        expect(op.message.content).toBe("from-db");
      }
    }
  });

  it("editMessage uses a pre-fetched messageSnapshots map keyed by messageId", async () => {
    const MESSAGE_ID = "01HXSXKBQ4TESTMSG00000000A" as Ulid;
    const EDIT_EVENT_ID = "01HXSXKBQ4TESTEDIT0000000B" as Ulid;
    const { asyncDb } = seedMessageDb({
      id: MESSAGE_ID,
      roomId: ROOM_ID,
      authorDid: USER_DID,
      authorName: "Alice",
      content: "from-db",
    });
    const snapshot: MessageDto = {
      id: MESSAGE_ID,
      content: "edited-from-snapshot",
      authorDid: USER_DID,
      authorName: "Alice",
      timestamp: "2026-05-08T12:00:00Z",
      reactions: [],
      media: [],
      linkEmbeds: [],
    };
    const snapshots = new Map([[MESSAGE_ID, snapshot]]);

    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.editMessage.v0",
        id: EDIT_EVENT_ID,
        roomId: ROOM_ID,
        details: { messageId: MESSAGE_ID },
      }),
      asyncDb,
      snapshots,
    );

    const diff = findMessageDiff(signals);
    expect(diff).toBeDefined();
    if (diff!.kind === "messageDiff") {
      const op = diff!.signal.ops[0]!;
      expect(op.op).toBe("update");
      expect(op.key).toBe(MESSAGE_ID);
      if (op.op === "update") {
        expect(op.message.content).toBe("edited-from-snapshot");
      }
    }
  });

  it("createMessage without roomId produces no signals", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.createMessage.v0",
      }),
    );
    expect(signals).toHaveLength(0);
  });

  it("createMessage in a federated room invalidates the receiving spaces", async () => {
    const { asyncDb } = seedMessageDb({
      id: EVENT_ID,
      roomId: ROOM_ID,
      authorDid: USER_DID,
      authorName: "Alice",
      content: "hello",
    });
    // Seed a read_positions row so the unread bump has a user to report.
    await asyncDb.run(
      "insert into readstate.read_positions (user_did, room_id, seen_up_to, unread_count) values (?, ?, ?, ?)",
      [USER_DID, ROOM_ID, "0", 1],
    );

    // A federation: ROOM_ID (stream A = STREAM_DID) is granted to B and C.
    const globalDb = new Database(":memory:");
    globalDb.exec(
      `create table if not exists space_federations (
         space_id text not null,
         federating_space_did text not null,
         status text not null,
         primary key (space_id, federating_space_did)
       ) strict;`,
    );
    globalDb.exec(
      `create table if not exists federation_room_permissions (
         space_id text not null,
         federating_space_did text not null,
         room_id text not null,
         permission text not null,
         primary key (space_id, federating_space_did, room_id)
       ) strict;`,
    );
    for (const home of ["did:web:space-b.example", "did:web:space-c.example"]) {
      globalDb.run(
        "insert into space_federations (space_id, federating_space_did, status) values (?, ?, 'active')",
        [STREAM_DID, home],
      );
      globalDb.run(
        "insert into federation_room_permissions (space_id, federating_space_did, room_id, permission) values (?, ?, ?, 'readwrite')",
        [STREAM_DID, home, ROOM_ID],
      );
    }
    // The handler reads messages + read state from the space DB and the
    // federation registry from the global DB; the same object exposes both.
    const db: DbLike = Object.assign(toAsyncDb(globalDb), {
      global: () => toAsyncDb(globalDb),
      ...asyncDb,
    });

    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.createMessage.v0",
        roomId: ROOM_ID,
        details: { content: "hello", authorName: "Alice" },
      }),
      db,
    );

    // One fed roomMetadataDiff per receiving space, plus the metadata +
    // getSpaces invalidations for each.
    const fedDiffs = signals.filter(
      (s): s is { kind: "roomMetadataDiff"; signal: RoomMetadataDiff } =>
        s.kind === "roomMetadataDiff" && s.signal.spaceId !== STREAM_DID,
    );
    expect(fedDiffs).toHaveLength(2);
    const fedHomes = fedDiffs
      .map((s) => s.signal.spaceId)
      .sort();
    expect(fedHomes).toEqual([
      "did:web:space-b.example" as StreamDid,
      "did:web:space-c.example" as StreamDid,
    ]);
    for (const diff of fedDiffs) {
      expect(diff.signal.roomId).toBe(ROOM_ID);
      expect(diff.signal.delta).toBe(1);
      expect(diff.signal.users).toContain(USER_DID);
    }

    // Receiving-space metadata invalidations for every fed home.
    const metaInvalidations = signals.filter(
      (s) =>
        s.kind === "queryInvalidation" &&
        s.signal.nsid === "space.roomy.space.getMetadata" &&
        s.signal.params["spaceId"] !== STREAM_DID,
    );
    expect(metaInvalidations).toHaveLength(2);
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
    // An edit can change the latest-message preview on the space index board.
    expect(nsids).toContain("space.roomy.space.getThreads");
    // editMessage should NOT invalidate space metadata (no unread change).
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
    // Deleting a room's latest message can reorder/drop it on the index board.
    expect(nsids).toContain("space.roomy.space.getThreads");
  });
});

// ─── Reaction events ────────────────────────────────────────────────────


describe("inferSignals: mentions", () => {
  const MENTIONED = "did:plc:bob" as UserDid;

  it("createMessage emits a mentionDiff per mentioned DID (excluding the author)", async () => {
    const { asyncDb } = seedMessageDb({
      id: EVENT_ID,
      roomId: ROOM_ID,
      authorDid: USER_DID,
      authorName: "Alice",
      content: "hello @bob",
    });
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.createMessage.v0",
        roomId: ROOM_ID,
        details: { mentions: [MENTIONED, USER_DID] }, // self-mention excluded
      }),
      asyncDb,
    );
    const mentionDiffs = findMentionDiffs(signals);
    expect(mentionDiffs).toHaveLength(1);
    const md = mentionDiffs[0]!;
    if (md.kind === "mentionDiff") {
      expect(md.signal.did).toBe(MENTIONED);
      expect(md.signal.spaceId).toBe(STREAM_DID);
      expect(md.signal.roomId).toBe(ROOM_ID);
      expect(md.signal.ops).toHaveLength(1);
      expect(md.signal.ops[0]!.op).toBe("add");
      expect(md.signal.ops[0]!.key).toBe(EVENT_ID);
    }
  });

  it("createMessage with no mentions emits no mentionDiff", async () => {
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
        details: {},
      }),
      asyncDb,
    );
    expect(findMentionDiffs(signals)).toHaveLength(0);
  });

  it("editMessage emits a mentionDiff update for the new mentions", async () => {
    const { asyncDb } = seedMessageDb({
      id: EVENT_ID,
      roomId: ROOM_ID,
      authorDid: USER_DID,
      authorName: "Alice",
      content: "edited @bob",
    });
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.editMessage.v0",
        roomId: ROOM_ID,
        details: { messageId: EVENT_ID, mentions: [MENTIONED] },
      }),
      asyncDb,
    );
    const mentionDiffs = findMentionDiffs(signals);
    expect(mentionDiffs).toHaveLength(1);
    const md = mentionDiffs[0]!;
    if (md.kind === "mentionDiff") {
      expect(md.signal.did).toBe(MENTIONED);
      expect(md.signal.ops[0]!.op).toBe("update");
      expect(md.signal.ops[0]!.key).toBe(EVENT_ID);
    }
  });

  it("deleteMessage emits a mentionDiff remove for the deleted message's DIDs", async () => {
    // Seed a global DB with a mentions row for the message being deleted.
    const globalDb = new Database(":memory:");
    globalDb.exec(
      "create table if not exists mentions (did text not null, message_id text not null, space_did text not null, room_id text not null, created_at integer not null default (unixepoch() * 1000), primary key (did, message_id)) strict",
    );
    globalDb.run(
      "insert into mentions (did, message_id, space_did, room_id) values (?, ?, ?, ?)",
      [MENTIONED, EVENT_ID, STREAM_DID, ROOM_ID],
    );
    const asyncGlobal = toAsyncDb(globalDb);
    const db = {
      global: () => asyncGlobal,
    } as unknown as DbLike;

    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.message.deleteMessage.v0",
        roomId: ROOM_ID,
        details: { messageId: EVENT_ID },
      }),
      db,
    );
    const mentionDiffs = findMentionDiffs(signals);
    expect(mentionDiffs).toHaveLength(1);
    const md = mentionDiffs[0]!;
    if (md.kind === "mentionDiff") {
      expect(md.signal.did).toBe(MENTIONED);
      expect(md.signal.ops[0]!.op).toBe("remove");
      expect(md.signal.ops[0]!.key).toBe(EVENT_ID);
    }
  });
});

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

// ─── Federation events ──────────────────────────────────────────────────

describe("inferSignals: federation events", () => {
  const B = "did:web:space-b.example";

  /** Collect query-invalidation signals for a specific nsid (incl. params). */
  function signalsFor(signals: InvalidationEvent[], nsid: QueryNsid) {
    return signals
      .filter(
        (s): s is { kind: "queryInvalidation"; signal: QueryInvalidation } =>
          s.kind === "queryInvalidation" && s.signal.nsid === nsid,
      )
      .map((s) => s.signal.params);
  }

  it("request invalidates A's request + outgoing views", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.federation.request.v0",
        details: { federatingSpaceDid: B },
      }),
    );
    expect(signalsFor(signals, "space.roomy.federation.getRequests")).toEqual([
      { spaceId: STREAM_DID },
    ]);
    expect(signalsFor(signals, "space.roomy.federation.getOutgoing")).toEqual([
      { spaceId: STREAM_DID },
    ]);
  });

  it("respond (approve) invalidates A views and B's sidebar/incoming", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.federation.respond.v0",
        details: { federatingSpaceDid: B },
      }),
    );
    expect(signalsFor(signals, "space.roomy.federation.getRequests")).toEqual([
      { spaceId: STREAM_DID },
    ]);
    expect(signalsFor(signals, "space.roomy.federation.getOutgoing")).toEqual([
      { spaceId: STREAM_DID },
    ]);
    expect(signalsFor(signals, "space.roomy.federation.getIncoming")).toEqual([
      { spaceId: B },
    ]);
    expect(signalsFor(signals, "space.roomy.space.getMetadata")).toEqual([
      { spaceId: B },
    ]);
    expect(signalsFor(signals, "space.roomy.space.getSpaces")).toEqual([{}]);
  });

  it("remove invalidates A's outgoing/grants and B's incoming/sidebar", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.federation.remove.v0",
        details: { federatingSpaceDid: B },
      }),
    );
    expect(signalsFor(signals, "space.roomy.federation.getOutgoing")).toEqual([
      { spaceId: STREAM_DID },
    ]);
    expect(signalsFor(signals, "space.roomy.federation.getGrants")).toEqual([
      { spaceId: STREAM_DID },
    ]);
    expect(signalsFor(signals, "space.roomy.space.getMetadata")).toEqual([
      { spaceId: B },
    ]);
  });

  it("setRoomPermission invalidates A grants/outgoing and B's sidebar", async () => {
    const signals = await inferSignals(
      makeEvent({
        type: "space.roomy.federation.setRoomPermission.v0",
        details: { federatingSpaceDid: B, roomId: ROOM_ID },
      }),
    );
    expect(signalsFor(signals, "space.roomy.federation.getGrants")).toEqual([
      { spaceId: STREAM_DID },
    ]);
    expect(signalsFor(signals, "space.roomy.federation.getOutgoing")).toEqual([
      { spaceId: STREAM_DID },
    ]);
    expect(signalsFor(signals, "space.roomy.space.getMetadata")).toEqual([
      { spaceId: B },
    ]);
  });

  it("setReceiverPermission invalidates B's grants + sidebar", async () => {
    // Receiver grants are authored on B's stream, so streamDid === B here.
    const signals = await inferSignals(
      makeEvent({
        streamDid: B as unknown as StreamDid,
        type: "space.roomy.federation.setReceiverPermission.v0",
        details: { originSpaceId: STREAM_DID, roomId: ROOM_ID },
      }),
    );
    expect(signalsFor(signals, "space.roomy.federation.getGrants")).toEqual([
      { spaceId: B },
    ]);
    expect(signalsFor(signals, "space.roomy.space.getMetadata")).toEqual([
      { spaceId: B },
    ]);
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
