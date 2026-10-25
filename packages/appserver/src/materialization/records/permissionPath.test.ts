/**
 * The membership and permission record paths reproduce the event path's
 * projection.
 *
 * One corpus is derived twice — once through the event materialisers, once
 * through the projection rules — and the two per-space databases are compared
 * with the rebuild-equality oracle's snapshot and diff, live and on replay. The
 * global DB is compared separately: a join, a leave and their markers are the
 * only rows these kinds write there.
 *
 * The corpus covers each kind's whole surface: two joins (with the announcement
 * in the space's first channel), a rejoin after a leave, an admin granted and
 * removed, a ban and an unban, an invite created and revoked, a role created,
 * updated and soft-deleted, a role granted and revoked, and a room permission
 * set and cleared.
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

const STREAM = StreamDid.assert("did:web:permission-record-path.example");
const USER = UserDid.assert("did:plc:record-path-user");
const OTHER = UserDid.assert("did:plc:record-path-other");
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

/** An in-memory global DB, which the membership and entity indexes route to. */
function freshGlobalDb(): Database {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec("pragma journal_mode = wal");
  db.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
  return db;
}

/** One log entry, with the receipt the append path would have stamped. */
function logged(event: Event, idx: number, user = USER): LoggedEvent {
  return {
    event,
    idx: idx as StreamIndex,
    user,
    receivedAt: RECEIVED_AT + idx,
    createdAt: RECEIVED_AT,
  };
}

/** The ids the corpus refers to. */
interface Corpus {
  channel: string;
  role: string;
  token: string;
}

function corpus(): { entries: LoggedEvent[]; fx: Corpus } {
  const fx: Corpus = {
    channel: newUlid(),
    role: newUlid(),
    token: "invite-token",
  };

  const events: Array<{ event: Event; user?: UserDid }> = [
    {
      event: {
        $type: "space.roomy.room.createRoom.v0",
        id: fx.channel,
        kind: "space.roomy.channel",
        name: "general",
      } as unknown as Event,
    },
    // The announcement lands in the channel above, which must already exist.
    {
      event: { $type: "space.roomy.space.joinSpace.v0", id: newUlid() } as unknown as Event,
      user: USER,
    },
    {
      event: { $type: "space.roomy.space.joinSpace.v0", id: newUlid() } as unknown as Event,
      user: OTHER,
    },
    {
      event: {
        $type: "space.roomy.space.addAdmin.v0",
        id: newUlid(),
        userDid: OTHER,
      } as unknown as Event,
    },
    {
      event: {
        $type: "space.roomy.space.removeAdmin.v0",
        id: newUlid(),
        userDid: OTHER,
      } as unknown as Event,
    },
    {
      event: { $type: "space.roomy.space.leaveSpace.v0", id: newUlid() } as unknown as Event,
      user: USER,
    },
    // A rejoin: the member edge returns, and the leave marker is cleared.
    {
      event: { $type: "space.roomy.space.joinSpace.v0", id: newUlid() } as unknown as Event,
      user: USER,
    },
    {
      event: {
        $type: "space.roomy.space.banAccount.v0",
        id: newUlid(),
        userDid: EXTERNAL,
      } as unknown as Event,
    },
    {
      event: {
        $type: "space.roomy.space.unbanAccount.v0",
        id: newUlid(),
        userDid: EXTERNAL,
      } as unknown as Event,
    },
    {
      event: {
        $type: "space.roomy.space.createInvite.v0",
        id: newUlid(),
        token: fx.token,
      } as unknown as Event,
    },
    {
      event: {
        $type: "space.roomy.space.revokeInvite.v0",
        id: newUlid(),
        token: fx.token,
      } as unknown as Event,
    },
    {
      event: {
        $type: "space.roomy.role.createRole.v0",
        id: fx.role,
        name: "Moderator",
        description: "keeps the peace",
      } as unknown as Event,
    },
    {
      event: {
        $type: "space.roomy.role.updateRole.v0",
        id: newUlid(),
        roleId: fx.role,
        name: "Moderator (renamed)",
        avatar: "atblob://role",
      } as unknown as Event,
    },
    {
      event: {
        $type: "space.roomy.role.addMemberRole.v0",
        id: newUlid(),
        userDid: OTHER,
        roleId: fx.role,
      } as unknown as Event,
    },
    {
      event: {
        $type: "space.roomy.role.setRoleRoomPermission.v0",
        id: newUlid(),
        roleId: fx.role,
        roomId: fx.channel,
        permission: "readwrite",
      } as unknown as Event,
    },
    {
      event: {
        $type: "space.roomy.role.setRoleRoomPermission.v0",
        id: newUlid(),
        roleId: fx.role,
        roomId: fx.channel,
        permission: null,
      } as unknown as Event,
    },
    {
      event: {
        $type: "space.roomy.role.removeMemberRole.v0",
        id: newUlid(),
        userDid: OTHER,
        roleId: fx.role,
      } as unknown as Event,
    },
    {
      event: {
        $type: "space.roomy.role.deleteRole.v0",
        id: newUlid(),
        roleId: fx.role,
      } as unknown as Event,
    },
  ];

  return {
    entries: events.map((entry, i) => logged(entry.event, i + 1, entry.user)),
    fx,
  };
}

interface Derived {
  space: TableSnapshot[];
  entitySpace: unknown[];
  membershipEdges: unknown[];
}

/** Derive the corpus through the record path or, with `eventPath`, the events. */
async function derive(
  entries: LoggedEvent[],
  opts: { eventPath: boolean; isBackfill: boolean },
): Promise<Derived> {
  const db = freshSpaceDb();
  const globalDb = freshGlobalDb();
  await db.run("insert into entities (id, stream_id, created_at, updated_at) values (?, ?, ?, ?)", [
    STREAM,
    STREAM,
    RECEIVED_AT,
    RECEIVED_AT,
  ]);
  await db.run(
      "insert into comp_space (entity, created_at, updated_at) values (?, ?, ?)",
      [STREAM, RECEIVED_AT, RECEIVED_AT],
    );

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
    membershipEdges: globalDb
      .query(
        `select head, tail, label from edges
          where label in ('joinedSpace', 'leftSpace')
          order by head, tail, label`,
      )
      .all(),
  };
}

describe("the membership-family record path derives what the event path derives", () => {
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
    expect(recordPath.membershipEdges).toEqual(eventPath.membershipEdges);
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
    expect(recordPath.membershipEdges).toEqual(eventPath.membershipEdges);
  });
});

describe("the corpus exercises each converted kind's ops", () => {
  test("the projection holds the end state the rules write", async () => {
    const { entries, fx } = corpus();
    const db = freshSpaceDb();
    const globalDb = freshGlobalDb();
    await db.run(
      "insert into entities (id, stream_id, created_at, updated_at) values (?, ?, ?, ?)",
      [STREAM, STREAM, RECEIVED_AT, RECEIVED_AT],
    );
    await db.run(
      "insert into comp_space (entity, created_at, updated_at) values (?, ?, ?)",
      [STREAM, RECEIVED_AT, RECEIVED_AT],
    );
    await applyBatch(db, STREAM, entries, { isBackfill: false }, toAsyncDb(globalDb));

    // OTHER was granted and demoted; USER left and rejoined.
    const members = await db
      .query(
        `select tail, json_extract(payload, '$.can') as can
           from edges where head = ? and label = 'member'
          order by tail`,
      )
      .all<{ tail: string; can: string }>(STREAM);
    expect(Object.fromEntries(members.map((m) => [m.tail, m.can]))).toEqual({
      [USER]: "post",
      [OTHER]: "post",
    });

    const admins = await db
      .query("select count(*) as n from edges where label = 'admin'")
      .get<{ n: number }>();
    expect(admins?.n).toBe(0);

    // The join announcements are content, one per join.
    const messages = await db
      .query("select count(*) as n from comp_content")
      .get<{ n: number }>();
    expect(messages?.n).toBe(3);

    const bans = await db
      .query("select count(*) as n from comp_bans")
      .get<{ n: number }>();
    expect(bans?.n).toBe(0);

    const invites = await db
      .query("select count(*) as n from comp_invite")
      .get<{ n: number }>();
    expect(invites?.n).toBe(0);

    const role = await db
      .query("select name, avatar, deleted from roles where id = ?")
      .get<{ name: string; avatar: string; deleted: number }>(fx.role);
    expect(role).toEqual({
      name: "Moderator (renamed)",
      avatar: "atblob://role",
      deleted: 1,
    });

    const grants = await db
      .query("select count(*) as n from member_roles")
      .get<{ n: number }>();
    expect(grants?.n).toBe(0);

    const permissions = await db
      .query("select count(*) as n from role_rooms")
      .get<{ n: number }>();
    expect(permissions?.n).toBe(0);
  });
});
