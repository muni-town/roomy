/**
 * The adapter's correctness — what makes WS3 S1 safe to land before anything
 * consumes it. Two descriptions of one log now live in this tree, and these
 * tests are the statement that they agree.
 *
 * Three properties, in the order they matter:
 *
 *  - **Exhaustiveness over the registry.** Every event type the SDK knows is
 *    either mapped or on the explicit no-record list, and the mapping table
 *    agrees with what the adapter emits. A new event type fails here rather than
 *    silently producing no records.
 *  - **The stamp is the projection's key.** `orderStamp` equals
 *    `entities.sort_idx` for the log entry that produced the change — the
 *    property that lets a worker sort by the stamp without reading the log.
 *  - **The changes describe the projection's own state.** A fixture space is
 *    built through `applyBatch`, the adapter runs over the same log, and each
 *    emitted record is resolved against the rows the materialiser wrote: same
 *    identity, same op, same derived `repo`.
 *
 * The fixture covers all 47 event types, so "the mapping is right" is a
 * statement about the whole registry rather than a sample of it. `sample()`
 * builds the one well-formed event per type that both halves use, so the
 * exhaustiveness test and the fixture cannot disagree about what an event of a
 * given type looks like.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  type Event,
  type EventType,
  type StreamIndex,
  StreamDid,
  UserDid,
  eventRegistry,
  newUlid,
} from "@roomy-space/sdk";
import { decodeTime } from "ulidx";

import { closeDb, openDb } from "../../db/db.ts";
import { toAsyncDb } from "../../db/syncAdapter.ts";
import type { DbLike } from "../../db/types.ts";
import { applyBatch } from "../applyBatch.ts";
import type { LoggedEvent } from "../types.ts";
import {
  NO_RECORD_EVENT_TYPES,
  NO_RECORD_SYNTHETIC_EVENT_TYPES,
  RECORD_KINDS_FOR_EVENT,
  toRecordChanges,
} from "./toRecordChanges.ts";
import type { RecordChange } from "./recordChange.ts";
import type { RecordKind } from "./recordKinds.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "..", "db", "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(__dirname, "..", "..", "db", "schema-global.sql");

const STREAM = StreamDid.assert("did:web:adapter-fixture.example");
const USER = UserDid.assert("did:plc:adapter-user");
const OTHER = UserDid.assert("did:plc:adapter-other");
const THIRD = UserDid.assert("did:plc:adapter-third");
/** The origin space of a receiver grant, which is not the stream it arrives on. */
const ORIGIN = "did:web:origin.example" as StreamDid;
/** The receiving space of an origin grant. */
const RECEIVING = "did:web:receiving.example" as StreamDid;

const RECEIVED_AT = 1_700_000_000_000;

// `applyBatch`'s side-effect path opens the read-state DB through the worker, so
// point the worker at an in-memory DB for the duration of a test.
beforeEach(() => {
  closeDb();
  openDb({ path: ":memory:" });
});
afterEach(() => {
  closeDb();
});

/** An in-memory per-space DB with the real schema. */
function freshSpaceDb(): Database {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return db;
}

/** An in-memory global DB, which the federation and membership rows route to. */
function freshGlobalDb(): Database {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
  return db;
}

/** One log entry, with the receipt the append path would have stamped. */
function logged(
  event: Event,
  idx: number,
  receivedAt = RECEIVED_AT,
): LoggedEvent {
  return {
    event,
    idx: idx as StreamIndex,
    user: USER,
    receivedAt,
    createdAt: receivedAt,
  };
}

/** Message content in the decoded `{ buf }` form the log carries. */
function content(text: string) {
  return {
    mimeType: "text/markdown",
    data: { buf: new TextEncoder().encode(text) },
  };
}

/** The ids the fixture's events refer to; filled in as the log is built. */
interface Fixture {
  channel: string;
  /** Linked from the channel and unlinked later in the log. */
  spareThread: string;
  /** Linked from the channel; the link stands. */
  thread: string;
  /** A message that survives the log, moved into the thread. */
  kept: string;
  /** A message whose content the log edits. */
  edited: string;
  /** A message the log deletes. */
  deleted: string;
  role: string;
  reaction: string;
  call: string;
  inviteToken: string;
}

function emptyFixture(): Fixture {
  return {
    channel: newUlid(),
    spareThread: newUlid(),
    thread: newUlid(),
    kept: newUlid(),
    edited: newUlid(),
    deleted: newUlid(),
    role: newUlid(),
    reaction: newUlid(),
    call: newUlid(),
    inviteToken: "fixture-token",
  };
}

/**
 * One well-formed event of `$type`.
 *
 * Well-formed enough that the materialiser runs: it reads fields without
 * validating them, so a missing field shows up as a projection error rather
 * than as a wrong record. `overrides` is how the fixture builds a second room or
 * a second message of a type it already used.
 */
function sample(
  $type: EventType,
  fx: Fixture,
  overrides: Record<string, unknown> = {},
): Event {
  const id = newUlid();
  const base = (fields: Record<string, unknown>) =>
    ({ $type, id, ...fields, ...overrides }) as unknown as Event;

  switch ($type) {
    case "space.roomy.message.createMessage.v0":
      return base({ room: fx.channel, body: content("hello"), extensions: {} });
    case "space.roomy.message.editMessage.v0":
      return base({
        room: fx.channel,
        messageId: fx.edited,
        body: content("after edit"),
      });
    case "space.roomy.message.deleteMessage.v0":
      return base({ room: fx.channel, messageId: fx.deleted });
    case "space.roomy.message.moveMessages.v0":
      return base({
        room: fx.channel,
        messageIds: [fx.kept],
        toRoomId: fx.thread,
      });
    case "space.roomy.message.reorderMessage.v0":
      return base({ room: fx.channel, messageId: fx.kept, after: fx.edited });
    case "space.roomy.message.forwardMessages.v0":
      return base({
        room: fx.thread,
        messageIds: [fx.kept],
        fromRoomId: fx.channel,
      });

    case "space.roomy.room.createRoom.v0":
      return base({ kind: "space.roomy.channel", name: "general" });
    case "space.roomy.room.updateRoom.v0":
      return base({ roomId: fx.channel, name: "general (renamed)" });
    case "space.roomy.room.deleteRoom.v0":
      return base({ roomId: fx.thread });
    case "space.roomy.room.restoreRoom.v0":
      return base({ roomId: fx.thread });

    case "space.roomy.reaction.addReaction.v0":
      return base({
        room: fx.channel,
        reactionTo: fx.edited,
        reaction: "👍",
      });
    case "space.roomy.reaction.removeReaction.v0":
      return base({ room: fx.channel, reactionId: fx.reaction });
    case "space.roomy.reaction.addBridgedReaction.v0":
      return base({
        room: fx.channel,
        reactionTo: fx.edited,
        reaction: "🎉",
        reactingUser: THIRD,
        extensions: {},
      });
    case "space.roomy.reaction.removeBridgedReaction.v0":
      return base({
        room: fx.channel,
        reactionId: fx.reaction,
        reactingUser: THIRD,
        extensions: {},
      });

    case "space.roomy.space.joinSpace.v0":
      return base({});
    case "space.roomy.space.leaveSpace.v0":
      return base({});
    case "space.roomy.space.updateSpaceInfo.v0":
      return base({ name: "Fixture space" });
    case "space.roomy.space.updateSidebar.v0":
      return base({
        categories: [{ name: "General", children: [fx.channel] }],
      });
    case "space.roomy.space.updateSidebar.v1":
      return base({
        categories: [
          { id: newUlid(), name: "General", children: [fx.channel] },
        ],
      });
    case "space.roomy.space.addAdmin.v0":
      return base({ userDid: OTHER });
    case "space.roomy.space.removeAdmin.v0":
      return base({ userDid: OTHER });
    case "space.roomy.space.setHandleProvider.v0":
      return base({ did: OTHER });
    case "space.roomy.space.banAccount.v0":
      return base({ userDid: THIRD });
    case "space.roomy.space.unbanAccount.v0":
      return base({ userDid: THIRD });
    case "space.roomy.space.createInvite.v0":
      return base({ token: fx.inviteToken });
    case "space.roomy.space.revokeInvite.v0":
      return base({ token: fx.inviteToken });

    case "space.roomy.page.editPage.v0":
      // A real byte array: this event's materialiser binds the content straight
      // to SQL, unlike the CBOR-wrapped form the message events carry.
      return base({
        room: fx.channel,
        body: {
          mimeType: "text/markdown",
          data: new TextEncoder().encode("a page"),
        },
      });

    case "space.roomy.user.updateProfile.v0":
      return base({ did: OTHER, name: "Other Person" });

    case "space.roomy.link.createRoomLink.v0":
      return base({
        room: fx.channel,
        linkToRoom: fx.thread,
        isCreationLink: true,
      });
    case "space.roomy.link.removeRoomLink.v0":
      // The spare thread, so the first thread's `parent` edge survives the log
      // and both directions are visible in one projection.
      return base({ room: fx.channel, linkToRoom: fx.spareThread });

    case "space.roomy.openmeet.configure.v0":
      return base({
        groupSlug: "fixture-group",
        tenantId: "tenant-1",
        apiUrl: "https://calendar.example",
      });

    case "space.roomy.state.markRead.v0":
      return base({ room: fx.channel });

    case "space.roomy.role.createRole.v0":
      return base({ name: "Moderator" });
    case "space.roomy.role.updateRole.v0":
      return base({ roleId: fx.role, description: "keeps the peace" });
    case "space.roomy.role.deleteRole.v0":
      return base({ roleId: fx.role });
    case "space.roomy.role.addMemberRole.v0":
      return base({ userDid: OTHER, roleId: fx.role });
    case "space.roomy.role.removeMemberRole.v0":
      return base({ userDid: OTHER, roleId: fx.role });
    case "space.roomy.role.setRoleRoomPermission.v0":
      return base({
        roleId: fx.role,
        roomId: fx.channel,
        permission: "readwrite",
      });

    case "space.roomy.federation.request.v0":
      return base({ federatingSpaceDid: RECEIVING, message: "please" });
    case "space.roomy.federation.respond.v0":
      return base({ federatingSpaceDid: RECEIVING, approve: true });
    case "space.roomy.federation.remove.v0":
      return base({ federatingSpaceDid: RECEIVING });
    case "space.roomy.federation.setRoomPermission.v0":
      return base({
        federatingSpaceDid: RECEIVING,
        roomId: fx.channel,
        permission: "read",
      });
    case "space.roomy.federation.setReceiverPermission.v0":
      // Sent on this space's stream, but the grant it writes is the origin
      // space's — so the two are different repos.
      return base({
        originSpaceId: ORIGIN,
        roomId: fx.channel,
        grantee: RECEIVING,
        kind: "members",
        permission: "read",
      });

    case "space.roomy.voice.callStarted.v0":
      return base({ room: fx.channel, callId: fx.call, source: "user" });
    case "space.roomy.voice.callJoined.v0":
      return base({
        room: fx.channel,
        callId: fx.call,
        userDid: OTHER,
        source: "user",
      });
    case "space.roomy.voice.callLeft.v0":
      return base({
        room: fx.channel,
        callId: fx.call,
        userDid: OTHER,
        source: "user",
      });
    case "space.roomy.voice.callEnded.v0":
      return base({ room: fx.channel, callId: fx.call, source: "user" });
  }
}

/**
 * Every event type, in an order the materialiser can apply: a room exists before
 * a message in it, a message exists before its edit, and a delete comes after the
 * record it removes.
 *
 * The last event per record decides the projection's end state, so this list is
 * also what the per-op assertions are about — `federation.remove` is last
 * because it removes the relationship and its grants, and `revokeInvite` comes
 * after `createInvite` for the same reason.
 *
 * The two event types this leaves out are the ones whose materialisers do not
 * run against the real schema, so a projection built from a log containing them
 * would be missing rows for reasons that have nothing to do with the adapter:
 *
 *  - `page.editPage` inserts into `comp_page_edits` a column named `event`, which
 *    the table does not have (`schema-space.sql` names it `data`), so the whole
 *    event fails to apply. Retired and unmapped either way.
 *  - `state.markRead` is rejected at the write path and its materialiser returns
 *    no statements, so it is a no-record type with nothing to project.
 *
 * Both are still covered by the exhaustiveness tests above, which is where "it
 * produces no record" is asserted.
 */
/** The event types `FIXTURE_ORDER` leaves out, with the reason stated there. */
const FIXTURE_EXCLUDED: ReadonlySet<EventType> = new Set<EventType>([
  "space.roomy.page.editPage.v0",
  "space.roomy.state.markRead.v0",
]);

const FIXTURE_ORDER: EventType[] = [
  "space.roomy.space.updateSpaceInfo.v0",
  "space.roomy.room.createRoom.v0",
  "space.roomy.space.joinSpace.v0",
  "space.roomy.space.addAdmin.v0",
  "space.roomy.space.removeAdmin.v0",
  "space.roomy.space.leaveSpace.v0",
  "space.roomy.space.setHandleProvider.v0",
  "space.roomy.space.updateSidebar.v0",
  "space.roomy.space.updateSidebar.v1",
  "space.roomy.link.createRoomLink.v0",
  "space.roomy.message.createMessage.v0",
  "space.roomy.message.editMessage.v0",
  "space.roomy.message.deleteMessage.v0",
  "space.roomy.message.forwardMessages.v0",
  "space.roomy.message.moveMessages.v0",
  "space.roomy.message.reorderMessage.v0",
  "space.roomy.reaction.addReaction.v0",
  "space.roomy.reaction.removeReaction.v0",
  "space.roomy.reaction.addBridgedReaction.v0",
  "space.roomy.reaction.removeBridgedReaction.v0",
  "space.roomy.space.banAccount.v0",
  "space.roomy.space.createInvite.v0",
  "space.roomy.role.createRole.v0",
  "space.roomy.role.updateRole.v0",
  "space.roomy.role.addMemberRole.v0",
  "space.roomy.role.setRoleRoomPermission.v0",
  "space.roomy.user.updateProfile.v0",
  "space.roomy.openmeet.configure.v0",
  "space.roomy.federation.request.v0",
  "space.roomy.federation.respond.v0",
  "space.roomy.federation.setRoomPermission.v0",
  "space.roomy.federation.setReceiverPermission.v0",
  "space.roomy.voice.callStarted.v0",
  "space.roomy.voice.callJoined.v0",
  "space.roomy.voice.callLeft.v0",
  "space.roomy.voice.callEnded.v0",
  "space.roomy.room.updateRoom.v0",
  "space.roomy.room.deleteRoom.v0",
  "space.roomy.room.restoreRoom.v0",
  "space.roomy.space.revokeInvite.v0",
  "space.roomy.space.unbanAccount.v0",
  "space.roomy.role.removeMemberRole.v0",
  "space.roomy.link.removeRoomLink.v0",
  "space.roomy.federation.remove.v0",
  "space.roomy.role.deleteRole.v0",
];

describe("the mapping covers every event type the SDK knows", () => {
  const registered = Object.keys(eventRegistry) as EventType[];

  test("the table names every registry key and nothing else", () => {
    expect(Object.keys(RECORD_KINDS_FOR_EVENT).sort()).toEqual(
      [...registered].sort(),
    );
  });

  test("no registered type is unmapped without a stated reason", () => {
    const unmapped: string[] = [];
    const bothWays: string[] = [];

    for (const $type of registered) {
      const kinds = RECORD_KINDS_FOR_EVENT[$type];
      const noRecord = NO_RECORD_EVENT_TYPES[$type];

      if (kinds === undefined) {
        unmapped.push($type);
      } else if (kinds.length === 0 && noRecord === undefined) {
        unmapped.push(`${$type} (declared empty, with no reason)`);
      } else if (kinds.length > 0 && noRecord !== undefined) {
        bothWays.push($type);
      }
    }

    // A new event type lands in one of these lists, never in neither.
    expect(unmapped).toEqual([]);
    expect(bothWays).toEqual([]);
  });

  test("every type emits exactly the kinds the table declares", () => {
    const disagreements: string[] = [];

    for (const $type of registered) {
      const declared = [...RECORD_KINDS_FOR_EVENT[$type]].sort();
      const emitted = [
        ...new Set(
          toRecordChanges(logged(sample($type, emptyFixture()), 1), STREAM).map(
            (change) => change.kind,
          ),
        ),
      ].sort();

      if (declared.join(",") !== emitted.join(",")) {
        disagreements.push(`${$type}: declared [${declared}], emitted [${emitted}]`);
      }
    }

    // This is the assertion a new event type has to satisfy: the table and the
    // switch describe the same mapping, and a type that produces nothing says so.
    expect(disagreements).toEqual([]);
  });

  test("the no-record list is exactly the types that emit nothing", () => {
    const silent = registered.filter(
      ($type) =>
        toRecordChanges(logged(sample($type, emptyFixture()), 1), STREAM)
          .length === 0,
    );
    // Compared as strings: the registry keys are the source of truth for the
    // type union, and this asserts set equality, not ordering.
    expect([...(silent as readonly string[])].sort()).toEqual(
      Object.keys(NO_RECORD_EVENT_TYPES).sort(),
    );
  });

  test("the synthetic types are neither registered nor mapped", () => {
    for (const $type of NO_RECORD_SYNTHETIC_EVENT_TYPES) {
      expect(registered as readonly string[]).not.toContain($type);
      expect(RECORD_KINDS_FOR_EVENT[$type as EventType]).toBeUndefined();
    }
  });
});

describe("the ordering stamp is the projection's key", () => {
  test("createMessage's stamp equals the sort_idx the materialiser wrote", async () => {
    const raw = freshSpaceDb();
    const db = toAsyncDb(raw);
    const fx = emptyFixture();
    const room = sample("space.roomy.room.createRoom.v0", fx);
    const message = sample("space.roomy.message.createMessage.v0", fx);
    const entries = [logged(room, 1), logged(message, 2, RECEIVED_AT + 5_000)];

    await applyBatch(db, STREAM, entries, { isBackfill: false });

    const [change] = toRecordChanges(entries[1]!, STREAM);
    const row = await db
      .query("select sort_idx from entities where id = ?")
      .get<{ sort_idx: string }>(message.id);

    expect(change?.kind).toBe("message");
    // The stamp is a brand over the same string, so this compares the value.
    expect(String(change?.orderStamp)).toBe(row!.sort_idx);
  });

  test("forwardMessages' stamp equals the sort_idx the materialiser wrote", async () => {
    const raw = freshSpaceDb();
    const db = toAsyncDb(raw);
    const fx = emptyFixture();
    const entries = [
      logged(sample("space.roomy.room.createRoom.v0", fx), 1),
      logged(
        sample("space.roomy.message.createMessage.v0", fx, {
          id: fx.kept,
          room: fx.channel,
        }),
        2,
      ),
      logged(
        sample("space.roomy.message.forwardMessages.v0", fx, {
          id: newUlid(),
        }),
        3,
        RECEIVED_AT + 9_000,
      ),
    ];

    await applyBatch(db, STREAM, entries, { isBackfill: false });

    const [change] = toRecordChanges(entries[2]!, STREAM);
    const row = await db
      .query("select sort_idx from entities where id = ?")
      .get<{ sort_idx: string }>(entries[2]!.event.id);

    expect(change?.kind).toBe("message");
    expect(String(change?.orderStamp)).toBe(row!.sort_idx);
  });

  test("the changes one entry emits share one stamp", () => {
    const fx = emptyFixture();
    const changes = toRecordChanges(
      logged(sample("space.roomy.link.createRoomLink.v0", fx), 7),
      STREAM,
    );
    expect(changes).toHaveLength(2);
    expect(changes[0]!.orderStamp).toBe(changes[1]!.orderStamp);
  });
});

describe("createRoomLink emits two records for two different rooms", () => {
  const fx = emptyFixture();
  const link = sample("space.roomy.link.createRoomLink.v0", fx);

  test("a room update keyed by the linked room, and a message create in the linking room", () => {
    const changes = toRecordChanges(logged(link, 3), STREAM);
    expect(changes).toHaveLength(2);

    const [roomChange, messageChange] = changes;
    if (roomChange?.kind !== "room" || roomChange.op !== "update") {
      throw new Error("expected a room update");
    }
    // Keyed by the linked room, not by the event's own room: they are two
    // different rooms and keying either by the event's `room` would be wrong.
    expect(String(roomChange.rkey)).toBe(fx.thread);
    expect(roomChange.record.parent).toBe(fx.channel);

    if (messageChange?.kind !== "message" || messageChange.op !== "create") {
      throw new Error("expected a message create");
    }
    expect(String(messageChange.rkey)).toBe(link.id);
    expect(messageChange.record.room).toBe(fx.channel);
  });

  test("the system message's actor is an explicit field, not the markdown", () => {
    const [, messageChange] = toRecordChanges(logged(link, 3), STREAM);
    if (messageChange?.kind !== "message" || messageChange.op !== "create") {
      throw new Error("expected a message create");
    }
    // The author edge points at the space, and the acting DID is carried
    // alongside it — recovering it from the rendered mention is what the record
    // model exists to avoid.
    expect(messageChange.repo).toBe(STREAM);
    expect(messageChange.record.author).toBe(STREAM);
    expect(messageChange.record.actor).toBe(USER);
    expect(messageChange.record.system).toEqual({
      kind: "roomLink",
      linkToRoom: fx.thread,
      isCreationLink: true,
    });
  });
});

describe("reorderMessage carries no record", () => {
  test("it maps to nothing rather than to an invented key", () => {
    const fx = emptyFixture();
    expect(
      toRecordChanges(
        logged(sample("space.roomy.message.reorderMessage.v0", fx), 9),
        STREAM,
      ),
    ).toEqual([]);
    expect(
      NO_RECORD_EVENT_TYPES["space.roomy.message.reorderMessage.v0"],
    ).toBeDefined();
  });
});

// ── The fixture: one space built through the real materialisation path ───

interface Built {
  entries: LoggedEvent[];
  changes: Array<{ change: RecordChange; entry: LoggedEvent }>;
  fx: Fixture;
  db: DbLike;
  globalDb: DbLike;
}

/**
 * Build a space from `FIXTURE_ORDER` through `applyBatch`, then adapt the same
 * log.
 *
 * The space's own entity and `comp_space` row are seeded the way `createStream`
 * writes them in production; everything else the log produces.
 */
async function buildFixture(): Promise<Built> {
  const fx = emptyFixture();
  const raw = freshSpaceDb();
  const db = toAsyncDb(raw);
  const globalDb = toAsyncDb(freshGlobalDb());

  raw.run("insert into entities (id, stream_id) values (?, ?)", [STREAM, STREAM]);
  raw.run("insert into comp_space (entity) values (?)", [STREAM]);

  let idx = 0;
  const entries: LoggedEvent[] = [];
  const push = ($type: EventType, overrides: Record<string, unknown> = {}) => {
    entries.push(logged(sample($type, fx, overrides), ++idx));
  };

  for (const $type of FIXTURE_ORDER) {
    // The events that name a room or a message by id get the fixture's ids; the
    // rest get fresh ones. Without this the log would reference rows it never
    // creates.
    switch ($type) {
      case "space.roomy.room.createRoom.v0":
        push($type, { id: fx.channel });
        push($type, { id: fx.thread, kind: "space.roomy.thread", name: "thread" });
        push($type, {
          id: fx.spareThread,
          kind: "space.roomy.thread",
          name: "spare thread",
        });
        continue;
      case "space.roomy.link.createRoomLink.v0":
        push($type, { room: fx.channel, linkToRoom: fx.thread });
        push($type, { room: fx.channel, linkToRoom: fx.spareThread });
        continue;
      case "space.roomy.message.createMessage.v0":
        push($type, { id: fx.kept, room: fx.channel });
        push($type, { id: fx.edited, room: fx.channel });
        push($type, { id: fx.deleted, room: fx.channel });
        continue;
      case "space.roomy.reaction.addReaction.v0":
        // The remove events name the add event's id.
        push($type, { id: fx.reaction });
        continue;
      case "space.roomy.role.createRole.v0":
        // updateRole/deleteRole/addMemberRole name the role by id.
        push($type, { id: fx.role });
        continue;
      default:
        push($type);
    }
  }

  // Re-adapt: the ids above only exist once the log is complete, and the
  // adapter is a pure function of an entry, so a second pass is exact.
  const stats = await applyBatch(
    db,
    STREAM,
    entries,
    { isBackfill: false },
    globalDb,
  );
  expect(stats.applyErrors).toBe(0);
  expect(stats.materializerErrors).toBe(0);

  const changes = entries.flatMap((entry) =>
    toRecordChanges(entry, STREAM).map((change) => ({ change, entry })),
  );
  return { entries, changes, fx, db, globalDb };
}

/**
 * The final change per record identity. A record is identified by its repo,
 * collection and rkey, so all three key it: a singleton's rkey is `self` in
 * every repo, and one log writes several.
 */
function lastPerRecord(
  changes: Array<{ change: RecordChange; entry: LoggedEvent }>,
): Map<string, RecordChange> {
  const last = new Map<string, RecordChange>();
  for (const { change } of changes) {
    last.set(`${change.kind}/${change.repo}/${change.rkey}`, change);
  }
  return last;
}

/**
 * The final change per projected row.
 *
 * A record's identity is `(repo, collection, rkey)`, and that is how
 * {@link lastPerRecord} keys it. The projection is per-space, though, so its rows
 * are keyed more coarsely: `profile` and `federationGrant` are the two kinds whose
 * row is selected by repo as well, and everything else is selected by rkey alone.
 * That is the difference `moveMessages` exposes — a message its author created
 * and the space later moved is ONE row written by two repos, which the record
 * model represents as two records until Stage 3 settles where curator actions
 * live (plan Q9).
 */
function lastPerRow(
  changes: Array<{ change: RecordChange; entry: LoggedEvent }>,
): Map<string, RecordChange> {
  const last = new Map<string, RecordChange>();
  for (const { change } of changes) {
    const repoScoped =
      change.kind === "profile" || change.kind === "federationGrant";
    last.set(
      repoScoped
        ? `${change.kind}/${change.repo}/${change.rkey}`
        : `${change.kind}/${change.rkey}`,
      change,
    );
  }
  return last;
}

/**
 * Whether the projection holds the record a change names.
 *
 * Each lookup is the read path's own key, so a disagreement is a wrong record
 * rather than a wrong spelling: the change is asked about through the same
 * columns the XRPC handlers query by.
 */
async function projectionHolds(
  change: RecordChange,
  db: DbLike,
  globalDb: DbLike,
): Promise<boolean> {
  const one = async (target: DbLike, sql: string, params: unknown[]) =>
    (await target.query(sql).get(...params)) !== null;

  switch (change.kind) {
    case "message":
      return one(db, "select 1 from entities where id = ?", [change.rkey]);
    case "reaction":
      return one(db, "select 1 from comp_reaction where reaction_id = ?", [
        change.rkey,
      ]);
    case "room":
      return one(db, "select 1 from comp_room where entity = ?", [change.rkey]);
    case "spaceInfo":
    case "spaceSidebar":
      return one(db, "select 1 from comp_space where entity = ?", [change.repo]);
    case "membership":
      return one(
        db,
        "select 1 from edges where head = ? and tail = ? and label = 'member'",
        [STREAM, change.rkey],
      );
    case "ban":
      return one(db, "select 1 from comp_bans where user_did = ?", [
        change.rkey,
      ]);
    case "invite":
      return one(db, "select 1 from comp_invite where token = ?", [
        change.rkey,
      ]);
    case "role":
      // A soft-deleted role is gone as far as every reader is concerned.
      return one(db, "select 1 from roles where id = ? and deleted = 0", [
        change.rkey,
      ]);
    case "roleGrant": {
      const [userId, roleId] = change.rkey.split("~");
      return one(
        db,
        "select 1 from member_roles where user_id = ? and role_id = ?",
        [userId, roleId],
      );
    }
    case "roomPermission": {
      const [roleId, roomId] = change.rkey.split("~");
      return one(
        db,
        "select 1 from role_rooms where role_id = ? and room_id = ?",
        [roleId, roomId],
      );
    }
    case "federationRequest":
      // `removed` is the projection's mark that the relationship was torn down.
      return one(
        globalDb,
        "select 1 from space_federations where space_id = ? and federating_space_did = ? and status != 'removed'",
        [change.repo, change.rkey],
      );
    case "federationGrant":
      // Either scope: both write rows keyed by the same (origin, receiver) pair.
      return (
        (await one(
          globalDb,
          "select 1 from federation_room_permissions where space_id = ? and federating_space_did = ?",
          [change.repo, change.rkey],
        )) ||
        (await one(
          globalDb,
          "select 1 from federation_receiver_permissions where space_id = ? and federating_space_did = ?",
          [change.repo, change.rkey],
        ))
      );
    case "profile":
      // The record's repo is the subject, so that is the row's entity.
      return one(db, "select 1 from comp_info where entity = ?", [
        change.repo,
      ]);
    case "calendarLink":
      return one(db, "select 1 from comp_calendar_link where entity = ?", [
        change.repo,
      ]);
    case "voiceCall":
      return one(db, "select 1 from active_calls where call_id = ?", [
        change.rkey,
      ]);
  }
}

describe("the changes describe the projection the materialiser built", () => {
  test("the fixture exercises every event type whose projection can be built", async () => {
    const { entries } = await buildFixture();
    const types = new Set(entries.map((entry) => entry.event.$type));
    const missing = (Object.keys(eventRegistry) as EventType[]).filter(
      ($type) => !types.has($type) && !FIXTURE_EXCLUDED.has($type),
    );
    // Otherwise "the mapping is right" would be a claim about a sample. The two
    // types left out are excluded for projection reasons, not mapping ones; see
    // `FIXTURE_ORDER`.
    expect(missing).toEqual([]);
  });

  test("the fixture emits all 16 kinds", async () => {
    const { changes } = await buildFixture();
    const kinds = new Set<RecordKind>(changes.map((c) => c.change.kind));
    expect((kinds as ReadonlySet<string>).size).toBe(16);
    expect([...kinds].sort() as string[]).toEqual(
      [
        "ban",
        "calendarLink",
        "federationGrant",
        "federationRequest",
        "invite",
        "membership",
        "message",
        "profile",
        "reaction",
        "role",
        "roleGrant",
        "room",
        "roomPermission",
        "spaceInfo",
        "spaceSidebar",
        "voiceCall",
      ].sort(),
    );
  });

  test("each record's final op matches what the projection holds", async () => {
    const { changes, db, globalDb } = await buildFixture();
    const final = lastPerRow(changes);
    const wrong: string[] = [];

    for (const [key, change] of final) {
      // `create`/`update` mean the record is in the set; `delete` means it is
      // not. Nothing else distinguishes them, which is why the projection is the
      // oracle rather than the op itself.
      const holds = await projectionHolds(change, db, globalDb);
      if (holds !== (change.op !== "delete")) {
        wrong.push(`${key}: op=${change.op}, projection holds=${holds}`);
      }
    }

    expect(wrong).toEqual([]);
    // Every op is represented, so the loop above is not vacuous.
    expect(new Set([...final.values()].map((c) => c.op))).toEqual(
      new Set(["create", "update", "delete"]),
    );
  });

  test("ids, keys and derived repos match the rows the materialiser wrote", async () => {
    const { changes, db, globalDb, fx } = await buildFixture();
    const final = lastPerRecord(changes);

    // ── message ──────────────────────────────────────────────────────────
    // `moveMessages` is the last write `kept` gets: a curator action by the
    // space, so the space is the record's repo even though the author edge still
    // names the sender.
    const moved = final.get(`message/${STREAM}/${fx.kept}`);
    if (moved?.kind !== "message" || moved.op !== "update") {
      throw new Error("expected the moved message's update");
    }
    const movedRow = await db
      .query(
        "select room, (select tail from edges where head = entities.id and label = 'author') as author from entities where id = ?",
      )
      .get<{ room: string; author: string }>(fx.kept);
    expect(movedRow?.room).toBe(fx.thread);
    expect(movedRow?.author).toBe(USER);
    expect(moved.record.room).toBe(movedRow?.room);

    // The edit replaces the content: `apply_dmp_patch` is never called (nothing
    // sends a dmp-patch), so "replace with the record's body" is what the
    // projection does — and the record carries the same bytes.
    const editChange = changes.find(
      (c) =>
        c.change.kind === "message" &&
        c.entry.event.$type === "space.roomy.message.editMessage.v0",
    )?.change;
    if (editChange?.kind !== "message" || editChange.op !== "update") {
      throw new Error("expected the edit's message update");
    }
    const editedRow = await db
      .query("select data from comp_content where entity = ?")
      .get<{ data: Uint8Array }>(fx.edited);
    const storedText = new TextDecoder().decode(editedRow!.data);
    expect(storedText).toBe("after edit");
    expect(new TextDecoder().decode(editChange.record.content!.data)).toBe(
      storedText,
    );

    // ── room ─────────────────────────────────────────────────────────────
    const threadRoom = final.get(`room/${STREAM}/${fx.thread}`);
    if (threadRoom?.kind !== "room" || threadRoom.op !== "update") {
      throw new Error("expected the thread's room record");
    }
    const threadRow = await db
      .query("select label, deleted from comp_room where entity = ?")
      .get<{ label: string; deleted: number }>(fx.thread);
    // The log deletes then restores the thread, so the end state is live; a room
    // is never `op: delete`, which is why the last write to one is an update.
    expect(threadRow?.label).toBe("space.roomy.thread");
    expect(threadRow?.deleted).toBe(0);
    expect(threadRoom.op).toBe("update");

    // The final room change is the restore, and a patch carries only the fields
    // it changes: no `parent`, no `name`. The link is a separate change against
    // the same record, asserted below.
    expect(threadRoom.record.deleted).toBe(false);
    expect(threadRoom.record.parent).toBeUndefined();

    // The unlink is the last write the spare thread's record gets, and it clears
    // the parent the link set — the other direction of the same field.
    const unlinked = final.get(`room/${STREAM}/${fx.spareThread}`);
    if (unlinked?.kind !== "room" || unlinked.op !== "update") {
      throw new Error("expected the unlinked room's update");
    }
    expect(unlinked.record.parent).toBeNull();
    const spareLink = await db
      .query("select 1 from edges where tail = ? and label = 'link'")
      .get(fx.spareThread);
    expect(spareLink).toBeNull();

    const linkChange = changes.find(
      (c) =>
        c.change.kind === "room" &&
        c.change.op === "update" &&
        c.entry.event.$type === "space.roomy.link.createRoomLink.v0",
    )?.change;
    if (linkChange?.kind !== "room" || linkChange.op !== "update") {
      throw new Error("expected the link's room update");
    }
    // The parent is the authorization input, and the projection's canonical
    // parent is the edge the link wrote.
    const linkEdge = await db
      .query(
        "select head from edges where tail = ? and label = 'link' and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1",
      )
      .get<{ head: string }>(fx.thread);
    expect(linkEdge?.head).toBe(fx.channel);
    expect(linkChange.record.parent).toBe(linkEdge?.head);

    // ── membership ───────────────────────────────────────────────────────
    // OTHER is added and then demoted: the same key, two changes, and `can`
    // mirrors the payload the projection stores.
    const member = final.get(`membership/${STREAM}/${OTHER}`);
    if (member?.kind !== "membership" || member.op === "delete") {
      throw new Error("expected the demoted member's record");
    }
    const memberEdge = await db
      .query(
        "select payload from edges where head = ? and tail = ? and label = 'member'",
      )
      .get<{ payload: string }>(STREAM, OTHER);
    expect(JSON.parse(memberEdge!.payload)).toEqual({ can: "post" });
    expect(member.record).toEqual({ can: "post" });

    // The joining user left, so their membership is gone from the projection —
    // and the adapter emitted a delete for it rather than an update.
    const left = final.get(`membership/${STREAM}/${USER}`);
    expect(left?.op).toBe("delete");

    // ── role ─────────────────────────────────────────────────────────────
    // `deleteRole` is the last write the role's record gets, so the final change
    // is a delete — and the projection agrees, because it marks the row deleted
    // and every reader filters on it. The update before it is checked separately.
    expect(final.get(`role/${STREAM}/${fx.role}`)?.op).toBe("delete");
    const roleUpdate = changes
      .filter(
        (c) =>
          c.change.kind === "role" &&
          c.change.op === "update" &&
          c.entry.event.$type === "space.roomy.role.updateRole.v0",
      )
      .at(-1)?.change;
    if (roleUpdate?.kind !== "role" || roleUpdate.op !== "update") {
      throw new Error("expected the role's update");
    }
    const roleRow = await db
      .query("select name, description from roles where id = ?")
      .get<{ name: string | null; description: string | null }>(fx.role);
    expect(roleRow?.name).toBe("Moderator");
    expect(roleUpdate.record.description).toBe(roleRow?.description);

    // ── singletons ───────────────────────────────────────────────────────
    const spaceInfo = final.get(`spaceInfo/${STREAM}/self`);
    if (spaceInfo?.kind !== "spaceInfo" || spaceInfo.op !== "update") {
      throw new Error("expected the space info update");
    }
    const info = await db
      .query("select name from comp_info where entity = ?")
      .get<{ name: string }>(STREAM);
    expect(spaceInfo.record.name).toBe(info?.name);

    const sidebar = final.get(`spaceSidebar/${STREAM}/self`);
    if (sidebar?.kind !== "spaceSidebar" || sidebar.op !== "update") {
      throw new Error("expected the sidebar update");
    }
    const sidebarRow = await db
      .query("select sidebar_config from comp_space where entity = ?")
      .get<{ sidebar_config: string }>(STREAM);
    // v1 is the last sidebar write, so the record carries its category ids.
    expect(JSON.parse(sidebarRow!.sidebar_config).categories).toEqual(
      sidebar.record.categories,
    );
    expect(sidebar.record.categories[0]?.id).toBeDefined();

    // ── federation: two records, two repos ───────────────────────────────
    const relationship = final.get(`federationRequest/${STREAM}/${RECEIVING}`);
    if (relationship?.kind !== "federationRequest" || relationship.op !== "delete") {
      throw new Error("expected the removed federation request");
    }
    // …and the projection marks it removed rather than dropping the row, which
    // is why the delete is the adapter's statement and `status` is the
    // projection's.
    const federationRow = await globalDb
      .query(
        "select status, requested_by_did from space_federations where space_id = ? and federating_space_did = ?",
      )
      .get<{ status: string; requested_by_did: string }>(STREAM, RECEIVING);
    expect(federationRow?.status).toBe("removed");

    const originGrant = final.get(`federationGrant/${STREAM}/${RECEIVING}`);
    expect(originGrant?.op).toBe("delete");

    // The receiver grant is the *origin space's* record, keyed by this space:
    // the event arrives here but the grant it writes belongs there.
    const receiverGrant = final.get(`federationGrant/${ORIGIN}/${STREAM}`);
    if (receiverGrant?.kind !== "federationGrant" || receiverGrant.op !== "update") {
      throw new Error("expected the receiver grant on the origin space");
    }
    expect(receiverGrant.repo).toBe(ORIGIN);
    expect(receiverGrant.record.scope).toBe("receiver");
    const receiverRow = await globalDb
      .query(
        "select room_id, permission from federation_receiver_permissions where space_id = ? and federating_space_did = ?",
      )
      .get<{ room_id: string; permission: string }>(ORIGIN, STREAM);
    if (receiverGrant.record.scope !== "receiver") {
      throw new Error("expected a receiver-scoped grant");
    }
    expect(receiverGrant.record.room).toBe(receiverRow?.room_id ?? "");

    // ── profile: the repo is the subject, not the sender ─────────────────
    const profile = final.get(`profile/${OTHER}/self`);
    if (profile?.kind !== "profile" || profile.op !== "update") {
      throw new Error("expected the other user's profile");
    }
    expect(profile.repo).toBe(OTHER);
    expect(profile.record.name).toBe("Other Person");

    // ── voice: `startedAt` is the start event's ULID time ────────────────
    const callCreate = changes.find(
      (c) => c.change.kind === "voiceCall" && c.change.op === "create",
    )?.change;
    if (callCreate?.kind !== "voiceCall" || callCreate.op !== "create") {
      throw new Error("expected the call's create");
    }
    expect(callCreate.record.room).toBe(fx.channel);
    // The projection writes `decodeTime(event.id)`, and the record carries the
    // same instant — not a wall-clock read at materialisation, which is what
    // makes it replayable.
    const startEntry = changes.find(
      (c) =>
        c.change.kind === "voiceCall" &&
        c.entry.event.$type === "space.roomy.voice.callStarted.v0",
    )!.entry;
    expect(callCreate.record.startedAt).toBe(decodeTime(startEntry.event.id));
    expect(final.get(`voiceCall/${STREAM}/${fx.call}`)?.op).toBe("delete");
  });

  test("repos are derived: the space for collective records, the author for member content", async () => {
    const { changes } = await buildFixture();
    const final = [...lastPerRecord(changes).values()];

    // Collective records belong to the space.
    for (const kind of [
      "room",
      "role",
      "spaceInfo",
      "spaceSidebar",
      "ban",
      "invite",
      "membership",
      "roleGrant",
      "roomPermission",
    ]) {
      for (const change of final.filter((c) => c.kind === kind)) {
        expect({ kind, repo: change.repo }).toEqual({ kind, repo: STREAM });
      }
    }

    // Member content belongs to whoever the projection attributes it to: the
    // sender for an authored message, the space for a link system message.
    const messageRepos = new Set(
      final.filter((c) => c.kind === "message").map((c) => c.repo),
    );
    expect(messageRepos).toEqual(new Set([USER, STREAM]));
  });
});

describe("the change type", () => {
  test("a delete carries no record", () => {
    const fx = emptyFixture();
    const change = toRecordChanges(
      logged(sample("space.roomy.space.unbanAccount.v0", fx), 1),
      STREAM,
    )[0]!;
    expect(change.kind).toBe("ban");
    expect(change.op).toBe("delete");
    expect("record" in change).toBe(false);
  });

  test("rkey rejects a value ATProto cannot key a record by", () => {
    const fx = emptyFixture();
    const event = sample("space.roomy.space.createInvite.v0", fx, {
      token: "not a valid/key",
    });
    expect(() => toRecordChanges(logged(event, 1), STREAM)).toThrow(
      /Not a valid record key/,
    );
  });

  test("a composite key recovers both parts, DIDs and all", () => {
    const fx = emptyFixture();
    const [change] = toRecordChanges(
      logged(sample("space.roomy.role.addMemberRole.v0", fx), 1),
      STREAM,
    );
    if (change?.kind !== "roleGrant" || change.op !== "create") {
      throw new Error("expected a role grant");
    }
    // The separator has to survive a DID, which itself contains `:`.
    expect(change.rkey.split("~")).toEqual([OTHER, fx.role]);
    expect(change.rkey).toContain(OTHER);
  });
});

describe("the rules the plan fixes for individual kinds", () => {
  const fx = emptyFixture();
  const changesFor = ($type: EventType, overrides: Record<string, unknown> = {}) =>
    toRecordChanges(logged(sample($type, fx, overrides), 1), STREAM);

  test("federation.remove emits two deletes, both keyed by the receiving space", () => {
    const changes = changesFor("space.roomy.federation.remove.v0");
    expect(changes.map((c) => [c.kind, c.op])).toEqual([
      ["federationRequest", "delete"],
      ["federationGrant", "delete"],
    ]);
    // The event names B and nothing finer, which is why both records are keyed
    // by B alone — a per-room grant record could not be deleted by this event.
    for (const change of changes) {
      expect(String(change.rkey)).toBe(RECEIVING);
      expect(change.repo).toBe(STREAM);
    }
  });

  test("setRoleRoomPermission with a null level is a delete, not an empty update", () => {
    const granted = changesFor("space.roomy.role.setRoleRoomPermission.v0")[0]!;
    const revoked = changesFor("space.roomy.role.setRoleRoomPermission.v0", {
      permission: null,
    })[0]!;

    expect(granted.kind).toBe("roomPermission");
    expect(granted.op).toBe("update");
    expect(revoked.kind).toBe("roomPermission");
    expect(revoked.op).toBe("delete");
    // One key, two ops — the same "delete then maybe insert" the materialiser
    // performs, expressed as the two operations it actually is.
    expect(String(granted.rkey)).toBe(String(revoked.rkey));
  });

  test("deleteRoom and restoreRoom are updates on the room, never deletes", () => {
    for (const [$type, deleted] of [
      ["space.roomy.room.deleteRoom.v0", true],
      ["space.roomy.room.restoreRoom.v0", false],
    ] as const) {
      const [change] = changesFor($type);
      if (change?.kind !== "room" || change.op !== "update") {
        throw new Error(`${$type} must be a room update`);
      }
      // The record carries the flag; the record itself stays in the set.
      expect(change.record).toEqual({ deleted });
    }
  });

  test("moveMessages keys each change by the message, not by the event's room", () => {
    const moved = newUlid();
    const [change] = changesFor("space.roomy.message.moveMessages.v0", {
      messageIds: [moved],
      toRoomId: fx.thread,
    });
    if (change?.kind !== "message" || change.op !== "update") {
      throw new Error("expected a message update");
    }
    expect(String(change.rkey)).toBe(moved);
    expect(change.record.room).toBe(fx.thread);
    // The repo is the space: a move is a curator action over content the actor
    // may not have written.
    expect(change.repo).toBe(STREAM);
  });

  test("the three no-record types carry no change at all", () => {
    // `editPage` and `setHandleProvider` are retired producers; `reorderMessage`
    // keys from its neighbours and cannot be expressed as a record.
    for (const $type of [
      "space.roomy.space.setHandleProvider.v0",
      "space.roomy.page.editPage.v0",
      "space.roomy.message.reorderMessage.v0",
      "space.roomy.state.markRead.v0",
    ] as const) {
      expect(changesFor($type)).toEqual([]);
    }
  });
});
