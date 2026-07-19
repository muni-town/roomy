import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, mock } from "bun:test";
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
import { defaultGetProfiles, ensureProfilesForBatch } from "./profiles.ts";
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

  test("skips DIDs we already have comp_info rows for", async () => {
    const { db, asyncDb } = freshDb();
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      ALICE,
      STREAM,
    ]);
    db.run("insert into comp_info (entity, name, avatar) values (?, ?, ?)", [
      ALICE,
      "alice.test",
      null,
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

  test("retries DIDs that have an entities row but no comp_info (failed fetch recovery)", async () => {
    // Regression: the message materialiser inserts an `entities` row for an
    // author via ensureEntity regardless of whether a profile was fetched.
    // A DID with entities-but-no-comp_info (e.g. after a failed getProfiles)
    // must still be retried, not permanently skipped.
    const { db, asyncDb } = freshDb();
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      ALICE,
      STREAM,
    ]);
    // NOTE: no comp_info row for ALICE — profile fetch previously failed.

    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(asyncDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);
    expect(
      (await asyncDb
        .query("select name from comp_info where entity = ?")
        .get<{ name: string }>(ALICE))?.name,
    ).toBe("alice.test display");
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


  test("re-fetches profiles for handle.invalid after cooldown elapses", async () => {
    const { db, asyncDb } = freshDb();
    // Seed ALICE with handle.invalid and an old updated_at (past cooldown)
    db.run("insert into entities (id, stream_id) values (?, ?)", [ALICE, STREAM]);
    db.run("insert into comp_info (entity, name, avatar) values (?, ?, ?)", [ALICE, "alice display", null]);
    db.run(
      "insert into comp_user (did, handle, updated_at) values (?, ?, ?)",
      [ALICE, "handle.invalid", Date.now() - 2 * 60 * 60 * 1000], // 2 hours ago
    );

    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.renewed.test")]);

    await ensureProfilesForBatch(asyncDb, events, getProfiles);

    // Should have fetched despite comp_info existing, because handle is stale
    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);
    expect(
      (await asyncDb
        .query("select handle from comp_user where did = ?")
        .get<{ handle: string }>(ALICE))?.handle,
    ).toBe("alice.renewed.test");
  });

  test("does NOT re-fetch handle.invalid within cooldown period", async () => {
    const { db, asyncDb } = freshDb();
    // Seed ALICE with handle.invalid and a recent updated_at (within cooldown)
    db.run("insert into entities (id, stream_id) values (?, ?)", [ALICE, STREAM]);
    db.run("insert into comp_info (entity, name, avatar) values (?, ?, ?)", [ALICE, "alice display", null]);
    db.run(
      "insert into comp_user (did, handle, updated_at) values (?, ?, ?)",
      [ALICE, "handle.invalid", Date.now() - 10 * 60 * 1000], // 10 minutes ago
    );

    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.renewed.test")]);

    await ensureProfilesForBatch(asyncDb, events, getProfiles);

    // Should NOT fetch — cooldown hasn't elapsed
    expect(getProfiles).toHaveBeenCalledTimes(0);
    expect(
      (await asyncDb
        .query("select handle from comp_user where did = ?")
        .get<{ handle: string }>(ALICE))?.handle,
    ).toBe("handle.invalid");
  });
});

describe("defaultGetProfiles", () => {
  const realFetch = globalThis.fetch;

  // Restore the real fetch after each test so we never leak the mock into
  // other tests in the same file/process.
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("uses the XRPC path with repeated actors= keys (not comma-joined)", async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request): Promise<Response> =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ profiles: [] }),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await defaultGetProfiles([ALICE, BOB]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(
      (fetchMock.mock.calls as unknown as [string][])[0]![0],
    );
    expect(url.pathname).toBe("/xrpc/app.bsky.actor.getProfiles");
    // Repeated `actors=` keys, NOT a comma-joined single value.
    expect(url.searchParams.getAll("actors")).toEqual([
      "did:plc:alice",
      "did:plc:bob",
    ]);
    expect(url.searchParams.get("actors")).toBe("did:plc:alice");
    expect([...url.searchParams.keys()]).toEqual(["actors", "actors"]);
  });

  test("chunks >25 DIDs into separate requests and concatenates results", async () => {
    const dids = Array.from({ length: 30 }, (_, i) =>
      UserDid.assert(`did:plc:user${String(i).padStart(2, "0")}`),
    );
    const fetchMock = mock(
      async (url: string | URL | Request): Promise<Response> => {
        const u = new URL(url.toString());
        const actors = u.searchParams.getAll("actors");
        // Assert the 25-actor cap is respected per request.
        expect(actors.length).toBeLessThanOrEqual(25);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profiles: actors.map((d) => ({ did: d, handle: `${d}.test` })),
          }),
        } as unknown as Promise<Response>;
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const profiles = await defaultGetProfiles(dids);

    // 30 DIDs → 25 + 5 = 2 requests.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(profiles).toHaveLength(30);
  });

  test("a failing chunk does not drop profiles from other chunks", async () => {
    const dids = Array.from({ length: 50 }, (_, i) =>
      UserDid.assert(`did:plc:u${String(i).padStart(2, "0")}`),
    );
    let call = 0;
    const fetchMock = mock(
      async (_url: string | URL | Request): Promise<Response> => {
        call++;
        // 50 DIDs / 25 = exactly 2 chunks; second chunk fails, first succeeds.
        if (call === 2) {
          return { ok: false, status: 503 } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profiles: [
              { did: `did:plc:survivor-${call}`, handle: "x.test" },
            ],
          }),
        } as unknown as Promise<Response>;
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const profiles = await defaultGetProfiles(dids);

    // 2 chunks (50/25); first succeeds, second returns 503 and is skipped.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First chunk's profile survives; second chunk's failure is skipped.
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.did).toBe("did:plc:survivor-1");
  });
});
