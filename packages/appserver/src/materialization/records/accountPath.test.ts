/**
 * The account and call record paths reproduce the event path's projection.
 *
 * The per-space snapshot covers `profile` (`comp_info` plus the bridged handle
 * on `comp_user`), `calendarLink`, and the two per-space call tables; the global
 * `voice_projected_calls` index and the (untouched) global `profiles` table are
 * compared separately.
 *
 * `profile` is the kind whose materialiser does least: profile hydration moved
 * to read time, so the event path writes only the space-local rows. The last
 * test asserts that the global `profiles` row set is empty after both
 * derivations — the rule emits nothing there because the materialiser emits
 * nothing there.
 *
 * The corpus covers a profile update with every basic field and one carrying
 * only a bridge handle, a calendar linked/cleared/relinked, and three calls: one
 * superseded in its room by a second call, one joined and left, and one in a
 * different room.
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

const STREAM = StreamDid.assert("did:web:account-record-path.example");
const USER = UserDid.assert("did:plc:record-path-user");
const OTHER = UserDid.assert("did:plc:record-path-other");

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

/** The ids the corpus refers to. */
interface Corpus {
  callSuperseded: string;
  callLive: string;
  callOtherRoom: string;
  firstRoom: string;
  secondRoom: string;
}

function corpus(): { entries: LoggedEvent[]; fx: Corpus } {
  const fx: Corpus = {
    callSuperseded: newUlid(),
    callLive: newUlid(),
    callOtherRoom: newUlid(),
    firstRoom: newUlid(),
    secondRoom: newUlid(),
  };

  const events = [
    {
      $type: "space.roomy.user.updateProfile.v0",
      id: newUlid(),
      did: USER,
      name: "Record",
      avatar: "atblob://avatar",
      description: "a profile",
    },
    // Only the bridge extension: the basic fields must be left alone.
    {
      $type: "space.roomy.user.updateProfile.v0",
      id: newUlid(),
      did: OTHER,
      extensions: {
        "space.roomy.extension.discordUserOrigin.v0": { handle: "other#1234" },
      },
    },
    {
      $type: "space.roomy.openmeet.configure.v0",
      id: newUlid(),
      groupSlug: "roomy-group",
      tenantId: "tenant-1",
      apiUrl: "https://openmeet.example",
    },
    {
      $type: "space.roomy.openmeet.configure.v0",
      id: newUlid(),
      groupSlug: null,
      tenantId: null,
      apiUrl: null,
    },
    {
      $type: "space.roomy.openmeet.configure.v0",
      id: newUlid(),
      groupSlug: "roomy-group-2",
      tenantId: "tenant-2",
      apiUrl: "https://openmeet-2.example",
    },
    // A call in the first room, joined twice, then superseded by a second call
    // in the same room — which drops the first call's participants.
    {
      $type: "space.roomy.voice.callStarted.v0",
      id: newUlid(),
      room: fx.firstRoom,
      callId: fx.callSuperseded,
      source: "user",
    },
    {
      $type: "space.roomy.voice.callJoined.v0",
      id: newUlid(),
      room: fx.firstRoom,
      callId: fx.callSuperseded,
      userDid: OTHER,
      source: "user",
    },
    {
      $type: "space.roomy.voice.callJoined.v0",
      id: newUlid(),
      room: fx.firstRoom,
      callId: fx.callSuperseded,
      userDid: USER,
      source: "livekit",
    },
    {
      $type: "space.roomy.voice.callStarted.v0",
      id: newUlid(),
      room: fx.firstRoom,
      callId: fx.callLive,
      source: "user",
    },
    {
      $type: "space.roomy.voice.callJoined.v0",
      id: newUlid(),
      room: fx.firstRoom,
      callId: fx.callLive,
      userDid: OTHER,
      source: "livekit",
    },
    {
      $type: "space.roomy.voice.callLeft.v0",
      id: newUlid(),
      room: fx.firstRoom,
      callId: fx.callLive,
      userDid: OTHER,
      source: "livekit",
    },
    {
      $type: "space.roomy.voice.callEnded.v0",
      id: newUlid(),
      room: fx.firstRoom,
      callId: fx.callLive,
      source: "user",
    },
    {
      $type: "space.roomy.voice.callStarted.v0",
      id: newUlid(),
      room: fx.secondRoom,
      callId: fx.callOtherRoom,
      source: "reconciliation",
    },
    {
      $type: "space.roomy.voice.callEnded.v0",
      id: newUlid(),
      room: fx.secondRoom,
      callId: fx.callOtherRoom,
      source: "reconciliation",
    },
  ] as unknown as Event[];

  return {
    entries: events.map((event, i) => logged(event, i + 1)),
    fx,
  };
}

interface Derived {
  space: TableSnapshot[];
  projectedCalls: unknown[];
  profiles: unknown[];
}

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
    projectedCalls: globalDb
      .query(
        `select room_id, space_id, call_id, started_at
           from voice_projected_calls order by room_id, call_id`,
      )
      .all(),
    profiles: globalDb.query("select * from profiles").all(),
  };
}

describe("the account-family record path derives what the event path derives", () => {
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

    expect(eventPath.space.some((t) => t.rows.length > 0)).toBe(true);

    expect(diffSnapshots(eventPath.space, recordPath.space)).toEqual([]);
    expect(digestOf(recordPath.space)).toBe(digestOf(eventPath.space));
    expect(recordPath.projectedCalls).toEqual(eventPath.projectedCalls);
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
    expect(recordPath.projectedCalls).toEqual(eventPath.projectedCalls);
  });

  test("neither path writes the global profile table", async () => {
    const { entries } = corpus();
    const eventPath = await derive(entries, {
      eventPath: true,
      isBackfill: false,
    });
    const recordPath = await derive(entries, {
      eventPath: false,
      isBackfill: false,
    });

    // Hydration is read-time work: the materialiser's profile output is the
    // space-local `comp_info`/`comp_user` rows, so both are empty here — and
    // the rule correctly emits nothing for the global table.
    expect(eventPath.profiles).toEqual([]);
    expect(recordPath.profiles).toEqual([]);
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

    const profile = await db
      .query("select name, avatar, description from comp_info where entity = ?")
      .get<{ name: string; avatar: string; description: string }>(USER);
    expect(profile).toEqual({
      name: "Record",
      avatar: "atblob://avatar",
      description: "a profile",
    });
    const handle = await db
      .query("select handle from comp_user where did = ?")
      .get<{ handle: string }>(OTHER);
    expect(handle?.handle).toBe("other#1234");
    // The handle-only write names no basic field, so it writes no `comp_info`
    // row at all — the same statement set the materialiser produces.
    const otherInfo = await db
      .query("select 1 from comp_info where entity = ?")
      .get(OTHER);
    expect(otherInfo).toBeNull();

    const calendar = await db
      .query(
        "select group_slug, tenant_id, api_url from comp_calendar_link where entity = ?",
      )
      .get<{ group_slug: string; tenant_id: string; api_url: string }>(STREAM);
    expect(calendar).toEqual({
      group_slug: "roomy-group-2",
      tenant_id: "tenant-2",
      api_url: "https://openmeet-2.example",
    });

    // A second call in one room updates the row's start time and source but
    // not its `call_id`, so that row still names the superseded call and the
    // later end — which names the live call — leaves it. The projection is
    // reproduced exactly as the event path leaves it.
    const calls = await db
      .query("select room_id, call_id from active_calls")
      .all<{ room_id: string; call_id: string }>();
    expect(calls).toEqual([
      { room_id: fx.firstRoom, call_id: fx.callSuperseded },
    ]);
    const participants = await db
      .query("select count(*) as n from call_participants")
      .get<{ n: number }>();
    expect(participants?.n).toBe(0);

    // The global index is keyed by room too, but its upsert does rewrite
    // `call_id`, so the first room's row names the live call and the end
    // removes it. The second room's call ended as well.
    const projected = globalDb
      .query("select room_id, call_id from voice_projected_calls")
      .all();
    expect(projected).toEqual([]);
    // The rooms the corpus named were never room entities, so the call facts
    // are the only writers of these tables.
    expect(fx.firstRoom).not.toBe(fx.secondRoom);
  });
});
