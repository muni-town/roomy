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

import { openDb } from "../db/db.ts";
import { ensureProfilesForBatch } from "./profiles.ts";

const STREAM = StreamDid.assert("did:web:profiles-test.example");
const ALICE = UserDid.assert("did:plc:alice");
const BOB = UserDid.assert("did:plc:bob");
const DISCORD_USER = UserDid.assert("did:discord:9999");

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
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
    const db = freshDb();
    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];

    await ensureProfilesForBatch(db, events, undefined);

    expect(
      db
        .query<{ count: number }, []>("select count(*) as count from entities")
        .get()?.count,
    ).toBe(0);
  });

  test("is a no-op when no events trigger profile lookup", async () => {
    const db = freshDb();
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

    await ensureProfilesForBatch(db, events, getProfiles);
    expect(getProfiles).toHaveBeenCalledTimes(0);
  });

  test("fetches profiles for joinSpace authors and inserts entity + comp_user + comp_info", async () => {
    const db = freshDb();
    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(db, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);

    expect(
      db
        .query<{ id: string }, [string]>("select id from entities where id = ?")
        .get(ALICE)?.id,
    ).toBe(ALICE);
    expect(
      db
        .query<
          { handle: string },
          [string]
        >("select handle from comp_user where did = ?")
        .get(ALICE)?.handle,
    ).toBe("alice.test");
    expect(
      db
        .query<
          { name: string; avatar: string },
          [string]
        >("select name, avatar from comp_info where entity = ?")
        .get(ALICE),
    ).toEqual({
      name: "alice.test display",
      avatar: "https://cdn.example/alice.test.png",
    });
  });

  test("skips DIDs we already have entity rows for", async () => {
    const db = freshDb();
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      ALICE,
      STREAM,
    ]);

    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, BOB),
    ];
    const getProfiles = mock(async () => [profileFor(BOB, "bob.test")]);

    await ensureProfilesForBatch(db, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([BOB]);
  });

  test("filters out non-bsky DIDs (e.g. did:discord:)", async () => {
    const db = freshDb();
    const events = [decodedAs(joinSpaceEvent(), 1, DISCORD_USER)];
    const getProfiles = mock(async () => [] as ProfileViewDetailed[]);

    await ensureProfilesForBatch(db, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(0);
  });

  test("includes authorOverride DIDs from createMessage extensions", async () => {
    const db = freshDb();
    const events = [
      decodedAs(createMessageEvent("did:plc:override-author"), 1, ALICE),
    ];
    const getProfiles = mock(async () => [
      profileFor(ALICE, "alice.test"),
      profileFor("did:plc:override-author", "override.test"),
    ]);

    await ensureProfilesForBatch(db, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    const arg = (getProfiles.mock.calls as unknown as UserDid[][][])[0]![0];
    expect(new Set(arg)).toEqual(
      new Set([ALICE, UserDid.assert("did:plc:override-author")]),
    );
  });

  test("dedupes the same DID across events", async () => {
    const db = freshDb();
    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, ALICE),
      decodedAs(joinSpaceEvent(), 3, ALICE),
    ];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(db, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);
  });

  test("tolerates getProfiles returning fewer profiles than requested", async () => {
    const db = freshDb();
    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, BOB),
    ];
    // Bob is unresolvable — appview returned only alice.
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(db, events, getProfiles);

    expect(
      db
        .query<{ count: number }, []>("select count(*) as count from entities")
        .get()?.count,
    ).toBe(1);
  });
});
