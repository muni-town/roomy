import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, mock } from "bun:test";
import { Database } from "bun:sqlite";
import {
  StreamDid,
  StreamIndex,
  UserDid,
  newUlid,
  type DecodedStreamEvent,
  type Event,
} from "@roomy-space/sdk";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";

import { toAsyncDb } from "../db/syncAdapter.ts";
import { ensureProfilesForBatch } from "./profiles.ts";
import type { DbLike } from "../db/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

const STREAM = StreamDid.assert("did:web:profiles-test.example");
const ALICE = UserDid.assert("did:plc:alice");
const BOB = UserDid.assert("did:plc:bob");
const DISCORD_USER = UserDid.assert("did:discord:9999");

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [SCHEMA_VERSION]);
  return { db, asyncDb: toAsyncDb(db) };
}

function decodedAs(
  event: Event,
  idx: number,
  user: UserDid,
): DecodedStreamEvent {
  return { event, idx: idx as StreamIndex, user };
}

function profileFor(did: string, handle: string): ProfileViewDetailed {
  return {
    did,
    handle,
    displayName: `${handle} display`,
    avatar: `https://cdn.example/${handle}.png`,
  } as ProfileViewDetailed;
}

function joinSpaceEvent(): Event {
  return {
    $type: "space.roomy.space.joinSpace.v0",
    id: newUlid(),
  } as unknown as Event;
}

function createMessageEvent(authorOverride?: string): Event {
  return {
    $type: "space.roomy.message.createMessage.v0",
    id: newUlid(),
    extensions: authorOverride
      ? {
          "space.roomy.extension.authorOverride.v0": { did: authorOverride },
        }
      : {},
  } as unknown as Event;
}

describe("ensureProfilesForBatch", () => {
  test("is a no-op when getProfiles is undefined", async () => {
    const { db, asyncDb } = freshDb();
    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];

    await ensureProfilesForBatch(asyncDb, events, undefined);

    expect(
      (await asyncDb
        .query("select count(*) as count from entities")
        .get<{ count: number }>())?.count,
    ).toBe(0);
  });

  test("is a no-op when no events trigger profile lookup", async () => {
    const { db, asyncDb } = freshDb();
    // createRoom isn't a NEW_USER_SIGNAL — should not trigger fetch.
    const events = [
      decodedAs(
        {
          $type: "space.roomy.room.createRoom.v0",
          id: newUlid(),
          kind: "space.roomy.channel",
        } as unknown as Event,
        1,
        ALICE,
      ),
    ];
    const getProfiles = mock(async () => [] as ProfileViewDetailed[]);

    await ensureProfilesForBatch(asyncDb, events, getProfiles);
    expect(getProfiles).toHaveBeenCalledTimes(0);
  });

  test("fetches profiles for joinSpace authors and inserts entity + comp_user + comp_info", async () => {
    const { db, asyncDb } = freshDb();
    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(asyncDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);

    expect(
      (await asyncDb
        .query("select id from entities where id = ?")
        .get<{ id: string }>(ALICE))?.id,
    ).toBe(ALICE);
    expect(
      (await asyncDb
        .query("select handle from comp_user where did = ?")
        .get<{ handle: string }>(ALICE))?.handle,
    ).toBe("alice.test");
    expect(
      await asyncDb
        .query("select name, avatar from comp_info where entity = ?")
        .get<{ name: string; avatar: string }>(ALICE),
    ).toEqual({
      name: "alice.test display",
      avatar: "https://cdn.example/alice.test.png",
    });
  });

  test("skips DIDs we already have entity rows for", async () => {
    const { db, asyncDb } = freshDb();
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      ALICE,
      STREAM,
    ]);

    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, BOB),
    ];
    const getProfiles = mock(async () => [profileFor(BOB, "bob.test")]);

    await ensureProfilesForBatch(asyncDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([BOB]);
  });

  test("filters out non-bsky DIDs (e.g. did:discord:)", async () => {
    const { db, asyncDb } = freshDb();
    const events = [decodedAs(joinSpaceEvent(), 1, DISCORD_USER)];
    const getProfiles = mock(async () => [] as ProfileViewDetailed[]);

    await ensureProfilesForBatch(asyncDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(0);
  });

  test("includes authorOverride DIDs from createMessage extensions", async () => {
    const { db, asyncDb } = freshDb();
    const events = [
      decodedAs(createMessageEvent("did:plc:override-author"), 1, ALICE),
    ];
    const getProfiles = mock(async () => [
      profileFor(ALICE, "alice.test"),
      profileFor("did:plc:override-author", "override.test"),
    ]);

    await ensureProfilesForBatch(asyncDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    const arg = (getProfiles.mock.calls as unknown as UserDid[][][])[0]![0];
    expect(new Set(arg)).toEqual(
      new Set([ALICE, UserDid.assert("did:plc:override-author")]),
    );
  });

  test("dedupes the same DID across events", async () => {
    const { db, asyncDb } = freshDb();
    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, ALICE),
      decodedAs(joinSpaceEvent(), 3, ALICE),
    ];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(asyncDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);
  });

  test("tolerates getProfiles returning fewer profiles than requested", async () => {
    const { db, asyncDb } = freshDb();
    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, BOB),
    ];
    // Bob is unresolvable — appview returned only alice.
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(asyncDb, events, getProfiles);

    expect(
      (await asyncDb
        .query("select count(*) as count from entities")
        .get<{ count: number }>())?.count,
    ).toBe(1);
  });
})
