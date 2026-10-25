/**
 * The federation record path reproduces the event path's global projection.
 *
 * Both kinds write the global DB only, so the comparison reads the three
 * federation tables rather than the per-space snapshot. Every column agrees,
 * including `requested_at` and `decided_at`: both paths stamp them from the
 * change's ordering stamp, which the log assigned at ingest.
 *
 * The corpus is the relationship's whole life: a request, an approval, an origin
 * grant and a receiver grant, a removal that marks the relationship and drops
 * both grants, a re-request that revives the removed row, and a rejection.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  type Event,
  StreamDid,
  type StreamIndex,
  UserDid,
  newUlid,
} from "@roomy-space/sdk";

import { closeDb, openDb } from "../../db/db.ts";
import { toAsyncDb } from "../../db/syncAdapter.ts";
import type { DbLike } from "../../db/types.ts";
import { snapshotSpaceDb } from "../../streams/rebuildEquality.ts";
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

const STREAM = StreamDid.assert("did:web:federation-record-path.example");
const ORIGIN = StreamDid.assert("did:web:origin.example");
const USER = UserDid.assert("did:plc:record-path-user");

const RECEIVED_AT = 1_700_000_000_000;

beforeEach(() => {
  // `applyBatch` opens the read-state DB through the worker.
  closeDb();
  openDb({ path: ":memory:" });
});
afterEach(() => {
  closeDb();
});

function freshSpaceDb(): DbLike {
  const raw = new Database(":memory:");
  raw.exec("pragma foreign_keys = on");
  raw.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return toAsyncDb(raw);
}

function freshGlobalDb(): Database {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec("pragma journal_mode = wal");
  db.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
  return db;
}

function logged(event: Event, idx: number): LoggedEvent {
  return {
    event,
    idx: idx as StreamIndex,
    user: USER,
    receivedAt: RECEIVED_AT + idx,
    createdAt: RECEIVED_AT,
  };
}

function corpus(): { entries: LoggedEvent[]; room: string } {
  const room = newUlid();
  const events = [
    {
      $type: "space.roomy.federation.request.v0",
      id: newUlid(),
      federatingSpaceDid: STREAM,
      message: "please",
    },
    {
      $type: "space.roomy.federation.respond.v0",
      id: newUlid(),
      federatingSpaceDid: STREAM,
      approve: true,
      message: "welcome",
    },
    {
      $type: "space.roomy.federation.setRoomPermission.v0",
      id: newUlid(),
      federatingSpaceDid: STREAM,
      roomId: room,
      permission: "readwrite",
    },
    {
      $type: "space.roomy.federation.setReceiverPermission.v0",
      id: newUlid(),
      originSpaceId: ORIGIN,
      roomId: room,
      grantee: STREAM,
      kind: "members",
      permission: "read",
    },
    // Removing the relationship marks it and drops both grants.
    {
      $type: "space.roomy.federation.remove.v0",
      id: newUlid(),
      federatingSpaceDid: STREAM,
    },
    // A request after removal revives the row as pending.
    {
      $type: "space.roomy.federation.request.v0",
      id: newUlid(),
      federatingSpaceDid: STREAM,
      message: "again",
    },
    {
      $type: "space.roomy.federation.respond.v0",
      id: newUlid(),
      federatingSpaceDid: STREAM,
      approve: false,
      message: "no",
    },
  ] as unknown as Event[];

  return { entries: events.map((event, i) => logged(event, i + 1)), room };
}

interface Derived {
  space: unknown;
  federations: unknown[];
  roomPermissions: unknown[];
  receiverPermissions: unknown[];
}

/** The federation tables, every column included. */
async function globalSnapshot(globalDb: Database): Promise<{
  federations: unknown[];
  roomPermissions: unknown[];
  receiverPermissions: unknown[];
}> {
  return {
    federations: globalDb
      .query(
        `select space_id, federating_space_did, status, requested_by_did,
                requested_at, message, decided_by_did, decided_at,
                decision_message
           from space_federations order by space_id, federating_space_did`,
      )
      .all(),
    roomPermissions: globalDb
      .query(
        `select space_id, federating_space_did, room_id, permission
           from federation_room_permissions
          order by space_id, federating_space_did, room_id`,
      )
      .all(),
    receiverPermissions: globalDb
      .query(
        `select space_id, federating_space_did, room_id, grantee, kind, permission
           from federation_receiver_permissions
          order by space_id, federating_space_did, room_id, grantee, kind`,
      )
      .all(),
  };
}

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
    ...(await globalSnapshot(globalDb)),
  };
}

describe("the federation record path derives what the event path derives", () => {
  test("a live write: the global tables match", async () => {
    const { entries } = corpus();
    const eventPath = await derive(entries, {
      eventPath: true,
      isBackfill: false,
    });
    const recordPath = await derive(entries, {
      eventPath: false,
      isBackfill: false,
    });

    expect(recordPath.federations).toEqual(eventPath.federations);
    expect(recordPath.roomPermissions).toEqual(eventPath.roomPermissions);
    expect(recordPath.receiverPermissions).toEqual(
      eventPath.receiverPermissions,
    );
    // Neither path writes per-space rows for these kinds.
    expect(recordPath.space).toEqual(eventPath.space);
  });

  test("a replay: the global tables match", async () => {
    const { entries } = corpus();
    const eventPath = await derive(entries, {
      eventPath: true,
      isBackfill: true,
    });
    const recordPath = await derive(entries, {
      eventPath: false,
      isBackfill: true,
    });

    expect(recordPath.federations).toEqual(eventPath.federations);
    expect(recordPath.roomPermissions).toEqual(eventPath.roomPermissions);
    expect(recordPath.receiverPermissions).toEqual(
      eventPath.receiverPermissions,
    );
  });
});

describe("the corpus exercises each converted kind's ops", () => {
  test("the relationship ends rejected, with no grants left", async () => {
    const { entries } = corpus();
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
    await applyBatch(
      db,
      STREAM,
      entries,
      { isBackfill: false },
      toAsyncDb(globalDb),
    );

    const relationship = globalDb
      .query(
        `select status, requested_by_did, decided_by_did, message, decision_message
           from space_federations
          where space_id = ? and federating_space_did = ?`,
      )
      .get(STREAM, STREAM) as {
      status: string;
      requested_by_did: string;
      decided_by_did: string;
      message: string;
      decision_message: string;
    };
    expect(relationship.status).toBe("rejected");
    expect(relationship.decided_by_did).toBe(USER);
    expect(relationship.message).toBe("again");
    expect(relationship.decision_message).toBe("no");

    const grants = globalDb
      .query("select count(*) as n from federation_room_permissions")
      .get() as { n: number };
    const receivers = globalDb
      .query("select count(*) as n from federation_receiver_permissions")
      .get() as { n: number };
    expect(grants.n).toBe(0);
    // The receiver grant belongs to the origin space it names, which is not the
    // stream the removal arrives on — so removing this relationship leaves it.
    expect(receivers.n).toBe(1);
    const receiver = globalDb
      .query(
        `select space_id, federating_space_did from federation_receiver_permissions`,
      )
      .get() as { space_id: string; federating_space_did: string };
    expect(receiver).toEqual({
      space_id: ORIGIN,
      federating_space_did: STREAM,
    });
  });
});
