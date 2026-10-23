/**
 * The room, space-config and reaction record paths reproduce the event path's
 * projection.
 *
 * One corpus is derived twice — once through the event materialisers, once
 * through the projection rules — and the two per-space databases are compared
 * with the rebuild-equality oracle's snapshot and diff, live and on replay.
 *
 * The corpus is the four kinds' whole surface: a space-info write and a policy
 * update, both sidebar forms, a channel/thread/category create (the category
 * carrying a Discord origin), a field-wise room update, the soft delete and
 * restore, a link and an unlink (the unlink exercising the parent the planner
 * reads), and a reaction in each of its four forms — the bridged add is what
 * materialises an external user's entity.
 *
 * A link emits a `room` update and a `message` create, so this corpus also
 * covers the system-message rule: the announcement is written once, with the
 * author edge on the space and no ordering key.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  type Event,
  type StreamIndex,
  StreamDid,
  UserDid,
  newUlid,
} from "@roomy-space/sdk";

import { closeDb, openDb } from "../../db/db.ts";
import { toAsyncDb } from "../../db/syncAdapter.ts";
import type { DbLike } from "../../db/types.ts";
import {
  type TableSnapshot,
  diffSnapshots,
  digestOf,
  snapshotSpaceDb,
} from "../../streams/rebuildEquality.ts";
import { applyBatch } from "../applyBatch.ts";
import type { LoggedEvent } from "../types.ts";
import { _withEventPath } from "./toRecordChanges.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "..", "db", "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(
  __dirname,
  "..",
  "..",
  "db",
  "schema-global.sql",
);

const STREAM = StreamDid.assert("did:web:room-record-path.example");
const USER = UserDid.assert("did:plc:record-path-user");
/** A user the space has never seen: the bridged add materialises them. */
const EXTERNAL = UserDid.assert("did:plc:record-path-external");

const RECEIVED_AT = 1_700_000_000_000;

beforeEach(() => {
  // `applyBatch` opens the read-state DB through the worker.
  closeDb();
  openDb({ path: ":memory:" });
});
afterEach(() => {
  closeDb();
});

/** An in-memory per-space DB with the real schema. */
function freshSpaceDb(): DbLike {
  const raw = new Database(":memory:");
  raw.exec("pragma foreign_keys = on");
  raw.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return toAsyncDb(raw);
}

/** An in-memory global DB, which the entity→space index routes to. */
function freshGlobalDb(): Database {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec("pragma journal_mode = wal");
  db.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
  return db;
}

/** One log entry, with the receipt the append path would have stamped. */
function logged(event: Event, idx: number): LoggedEvent {
  return {
    event,
    idx: idx as StreamIndex,
    user: USER,
    receivedAt: RECEIVED_AT + idx,
    createdAt: RECEIVED_AT,
  };
}

/** A message body in the decoded `{ buf }` form the log carries. */
function markdown(text: string) {
  return {
    mimeType: "text/markdown",
    data: { buf: new TextEncoder().encode(text) },
  };
}

/** The ids the corpus refers to. */
interface Corpus {
  channel: string;
  thread: string;
  category: string;
  /** Carries a link that the corpus removes again. */
  unlinked: string;
  /** The system message an unlink does not write. */
  linkMessage: string;
  message: string;
  reaction: string;
  bridgedReaction: string;
}

function corpus(): { entries: LoggedEvent[]; fx: Corpus } {
  const fx: Corpus = {
    channel: newUlid(),
    thread: newUlid(),
    category: newUlid(),
    unlinked: newUlid(),
    linkMessage: newUlid(),
    message: newUlid(),
    reaction: newUlid(),
    bridgedReaction: newUlid(),
  };

  const events = [
    {
      $type: "space.roomy.space.updateSpaceInfo.v0",
      id: newUlid(),
      name: "Rooms",
      allowPublicJoin: true,
    },
    {
      $type: "space.roomy.space.updateSpaceInfo.v0",
      id: newUlid(),
      avatar: "atblob://avatar",
      allowMemberInvites: null,
      suggestToOthers: false,
    },
    {
      $type: "space.roomy.space.updateSidebar.v0",
      id: newUlid(),
      categories: [{ name: "General", children: [fx.channel] }],
    },
    {
      $type: "space.roomy.space.updateSidebar.v1",
      id: newUlid(),
      categories: [
        { id: newUlid(), name: "General", children: [fx.channel] },
      ],
      extensions: { "space.roomy.extension.sidebar.v0": { collapsed: [] } },
    },
    {
      $type: "space.roomy.room.createRoom.v0",
      id: fx.channel,
      kind: "space.roomy.channel",
      name: "general",
      avatar: "atblob://channel",
      description: "the main channel",
      defaultAccess: "read",
    },
    {
      $type: "space.roomy.room.createRoom.v0",
      id: fx.thread,
      kind: "space.roomy.thread",
      name: "a thread",
    },
    {
      $type: "space.roomy.room.createRoom.v0",
      id: fx.category,
      kind: "space.roomy.category",
      name: "a category",
      extensions: {
        "space.roomy.extension.discordOrigin.v0": {
          snowflake: "1234",
          guildId: "5678",
        },
      },
    },
    {
      $type: "space.roomy.room.createRoom.v0",
      id: fx.unlinked,
      kind: "space.roomy.channel",
      name: "unlinked",
    },
    {
      $type: "space.roomy.room.updateRoom.v0",
      id: newUlid(),
      roomId: fx.channel,
      name: "general (renamed)",
      defaultAccess: null,
      description: "still the main channel",
    },
    {
      $type: "space.roomy.room.deleteRoom.v0",
      id: newUlid(),
      roomId: fx.thread,
    },
    {
      $type: "space.roomy.room.restoreRoom.v0",
      id: newUlid(),
      roomId: fx.thread,
    },
    // A link and its announcement, then an unlink of a second room from the
    // same parent. Both write the same `link` edge shape.
    {
      $type: "space.roomy.link.createRoomLink.v0",
      id: fx.linkMessage,
      room: fx.channel,
      linkToRoom: fx.thread,
      isCreationLink: true,
    },
    {
      $type: "space.roomy.link.createRoomLink.v0",
      id: newUlid(),
      room: fx.channel,
      linkToRoom: fx.unlinked,
      isCreationLink: false,
    },
    {
      $type: "space.roomy.link.removeRoomLink.v0",
      id: newUlid(),
      room: fx.channel,
      linkToRoom: fx.unlinked,
    },
    // A message gives the reactions a target and gives USER an entity.
    {
      $type: "space.roomy.message.createMessage.v0",
      id: fx.message,
      room: fx.channel,
      body: markdown("react to me"),
      extensions: {},
    },
    {
      $type: "space.roomy.reaction.addReaction.v0",
      id: fx.reaction,
      room: fx.channel,
      reactionTo: fx.message,
      reaction: "👍",
    },
    {
      $type: "space.roomy.reaction.addBridgedReaction.v0",
      id: fx.bridgedReaction,
      room: fx.channel,
      reactionTo: fx.message,
      reaction: "🎉",
      reactingUser: EXTERNAL,
      extensions: {},
    },
    {
      $type: "space.roomy.reaction.removeReaction.v0",
      id: newUlid(),
      room: fx.channel,
      reactionId: fx.reaction,
    },
    {
      $type: "space.roomy.reaction.removeBridgedReaction.v0",
      id: newUlid(),
      room: fx.channel,
      reactionId: fx.bridgedReaction,
      reactingUser: EXTERNAL,
      extensions: {},
    },
  ] as unknown as Event[];

  return {
    entries: events.map((event, i) => logged(event, i + 1)),
    fx,
  };
}

interface Derived {
  space: TableSnapshot[];
  entitySpace: unknown[];
  /** The side tables the snapshot does not cover. */
  tables: Record<string, unknown[]>;
}

/** Read the tables the snapshot excludes or that live only in the global DB. */
async function sideTables(
  db: DbLike,
  globalDb: Database,
): Promise<Record<string, unknown[]>> {
  return {
    comp_reaction: await db
      .query(
        "select entity, user, reaction_id, reaction from comp_reaction order by entity, user, reaction",
      )
      .all(),
    comp_discord_origin: await db
      .query(
        "select entity, snowflake, guild_id from comp_discord_origin order by entity",
      )
      .all(),
    roomAccess: await db
      .query(
        "select room_id, space_id, parent_channel_id from room_access order by room_id",
      )
      .all(),
    entitySpace: globalDb
      .query("select entity_id, space_did from entity_space order by entity_id")
      .all(),
  };
}

/** Derive the corpus through the record path or, with `eventPath`, the events. */
async function derive(
  entries: LoggedEvent[],
  opts: { eventPath: boolean; isBackfill: boolean },
): Promise<Derived> {
  const db = freshSpaceDb();
  const globalDb = freshGlobalDb();
  await db.run("insert into entities (id, stream_id) values (?, ?)", [
    STREAM,
    STREAM,
  ]);
  await db.run("insert into comp_space (entity) values (?)", [STREAM]);

  const apply = () =>
    applyBatch(db, STREAM, entries, { isBackfill: opts.isBackfill }, toAsyncDb(globalDb));
  const stats = await (opts.eventPath ? _withEventPath(apply) : apply());

  expect(stats.failed).toEqual([]);
  expect(stats.applyErrors).toBe(0);
  expect(stats.materializerErrors).toBe(0);

  return {
    space: await snapshotSpaceDb(db),
    entitySpace: globalDb
      .query("select entity_id, space_did from entity_space order by entity_id")
      .all(),
    tables: await sideTables(db, globalDb),
  };
}

describe("the room-family record path derives what the event path derives", () => {
  test("a live write: every derived table matches", async () => {
    const { entries } = corpus();
    const eventPath = await derive(entries, {
      eventPath: true,
      isBackfill: false,
    });
    const recordPath = await derive(entries, {
      eventPath: false,
      isBackfill: false,
    });

    // The derivation wrote rows, so this is not two empty databases agreeing.
    expect(eventPath.space.some((t) => t.rows.length > 0)).toBe(true);

    expect(diffSnapshots(eventPath.space, recordPath.space)).toEqual([]);
    expect(digestOf(recordPath.space)).toBe(digestOf(eventPath.space));
    expect(recordPath.tables).toEqual(eventPath.tables);
    expect(recordPath.entitySpace).toEqual(eventPath.entitySpace);
  });

  test("a replay: every derived table matches", async () => {
    const { entries } = corpus();
    const eventPath = await derive(entries, {
      eventPath: true,
      isBackfill: true,
    });
    const recordPath = await derive(entries, {
      eventPath: false,
      isBackfill: true,
    });

    expect(diffSnapshots(eventPath.space, recordPath.space)).toEqual([]);
    expect(recordPath.tables).toEqual(eventPath.tables);
  });
});

describe("the corpus exercises each converted kind's ops", () => {
  test("the projection holds the end state the rules write", async () => {
    const { entries, fx } = corpus();
    const db = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await db.run("insert into entities (id, stream_id) values (?, ?)", [
      STREAM,
      STREAM,
    ]);
    await db.run("insert into comp_space (entity) values (?)", [STREAM]);
    await applyBatch(db, STREAM, entries, { isBackfill: false }, toAsyncDb(globalDb));

    const channel = await db
      .query(
        "select label, default_access, deleted from comp_room where entity = ?",
      )
      .get<{ label: string; default_access: string; deleted: number }>(fx.channel);
    expect(channel?.label).toBe("space.roomy.channel");
    // An explicit null access is stored as `readwrite`, as the projection does.
    expect(channel?.default_access).toBe("readwrite");

    const thread = await db
      .query("select deleted from comp_room where entity = ?")
      .get<{ deleted: number }>(fx.thread);
    expect(thread?.deleted).toBe(0);

    const origin = await db
      .query(
        "select snowflake, guild_id from comp_discord_origin where entity = ?",
      )
      .get<{ snowflake: string; guild_id: string }>(fx.category);
    expect(origin).toEqual({ snowflake: "1234", guild_id: "5678" });

    // The thread keeps its link; the unlinked room's edge is gone.
    const links = await db
      .query("select tail from edges where label = 'link' order by tail")
      .all<{ tail: string }>();
    expect(links.map((row) => row.tail)).toEqual([fx.thread]);

    const config = await db
      .query("select sidebar_config from comp_space where entity = ?")
      .get<{ sidebar_config: string }>(STREAM);
    expect(JSON.parse(config!.sidebar_config).categories).toHaveLength(1);

    // Every reaction was removed, including the bridged one that created the
    // external user's entity.
    const reactions = await db
      .query("select count(*) as n from comp_reaction")
      .get<{ n: number }>();
    expect(reactions?.n).toBe(0);
  });
});
