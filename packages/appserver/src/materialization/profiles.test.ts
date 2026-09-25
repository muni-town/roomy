import { afterEach, beforeEach, describe, expect, test, mock, setSystemTime } from "bun:test";
import {
  StreamIndex,
  UserDid,
  newUlid,
  type DecodedStreamEvent,
  type Event,
} from "@roomy-space/sdk";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";

import { closeDb, openDb, openGlobalDb } from "../db/db.ts";
import { defaultGetProfiles, ensureProfilesForBatch, _resetProfileNegativeCache } from "./profiles.ts";
import type { DbLike } from "../db/types.ts";

const ALICE = UserDid.assert("did:plc:alice");
const BOB = UserDid.assert("did:plc:bob");
const DISCORD_USER = UserDid.assert("did:discord:9999");

/**
 * Set up the worker-backed global DB (the authoritative `profiles` store).
 * Profiles live in the global `profiles` table, so these tests seed
 * and assert against the global DB.
 */
function freshGlobal(): { globalDb: DbLike } {
  closeDb();
  openDb({ path: ":memory:" });
  const globalDb = openGlobalDb();
  return { globalDb };
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
    const { globalDb } = freshGlobal();
    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];

    await ensureProfilesForBatch(globalDb, events, undefined);

    expect(
      (await globalDb
        .query("select count(*) as count from profiles")
        .get<{ count: number }>())?.count,
    ).toBe(0);
  });

  test("is a no-op when no events trigger profile lookup", async () => {
    const { globalDb } = freshGlobal();
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

    await ensureProfilesForBatch(globalDb, events, getProfiles);
    expect(getProfiles).toHaveBeenCalledTimes(0);
  });

  test("fetches profiles for joinSpace authors and inserts a global profile row", async () => {
    const { globalDb } = freshGlobal();
    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);

    const row = await globalDb
      .query("select did, handle, name, avatar from profiles where did = ?")
      .get<{ did: string; handle: string; name: string; avatar: string }>(ALICE);
    expect(row?.did).toBe(ALICE);
    expect(row?.handle).toBe("alice.test");
    expect(row?.name).toBe("alice.test display");
    expect(row?.avatar).toBe("https://cdn.example/alice.test.png");
  });

  test("skips DIDs we already have a global profile row for", async () => {
    const { globalDb } = freshGlobal();
    await globalDb.run(
      "insert into profiles (did, handle, name) values (?, ?, ?)",
      [ALICE, "alice.test", "alice.test display"],
    );

    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, BOB),
    ];
    const getProfiles = mock(async () => [profileFor(BOB, "bob.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([BOB]);
  });

  test("retries DIDs that have no global profile row (failed fetch recovery)", async () => {
    // A DID whose profile fetch failed has no row in the global `profiles`
    // table, so it must be retried, not skipped.
    const { globalDb } = freshGlobal();
    // NOTE: no profile row for ALICE — her profile fetch failed.

    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);
    expect(
      (await globalDb
        .query("select name from profiles where did = ?")
        .get<{ name: string }>(ALICE))?.name,
    ).toBe("alice.test display");
  });

  test("filters out non-bsky DIDs (e.g. did:discord:)", async () => {
    const { globalDb } = freshGlobal();
    const events = [decodedAs(joinSpaceEvent(), 1, DISCORD_USER)];
    const getProfiles = mock(async () => [] as ProfileViewDetailed[]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(0);
  });

  test("includes authorOverride DIDs from createMessage extensions", async () => {
    const { globalDb } = freshGlobal();
    const events = [
      decodedAs(createMessageEvent("did:plc:override-author"), 1, ALICE),
    ];
    const getProfiles = mock(async () => [
      profileFor(ALICE, "alice.test"),
      profileFor("did:plc:override-author", "override.test"),
    ]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    const arg = (getProfiles.mock.calls as unknown as UserDid[][][])[0]![0];
    expect(new Set(arg)).toEqual(
      new Set([ALICE, UserDid.assert("did:plc:override-author")]),
    );
  });

  test("dedupes the same DID across events", async () => {
    const { globalDb } = freshGlobal();
    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, ALICE),
      decodedAs(joinSpaceEvent(), 3, ALICE),
    ];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);
  });

  test("tolerates getProfiles returning fewer profiles than requested", async () => {
    const { globalDb } = freshGlobal();
    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, BOB),
    ];
    // Bob is unresolvable — appview returned only alice.
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(
      (await globalDb
        .query("select count(*) as count from profiles")
        .get<{ count: number }>())?.count,
    ).toBe(1);
  });

  test("re-fetches profiles for handle.invalid after cooldown elapses", async () => {
    const { globalDb } = freshGlobal();
    // Seed ALICE with handle.invalid and an old updated_at (past cooldown)
    await globalDb.run(
      "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
      [ALICE, "handle.invalid", "alice display", Date.now() - 2 * 60 * 60 * 1000], // 2 hours ago
    );

    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.renewed.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    // Should have fetched despite a profile existing, because handle is stale
    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);
    expect(
      (await globalDb
        .query("select handle from profiles where did = ?")
        .get<{ handle: string }>(ALICE))?.handle,
    ).toBe("alice.renewed.test");
  });

  test("does NOT re-fetch handle.invalid within cooldown period", async () => {
    const { globalDb } = freshGlobal();
    // Seed ALICE with handle.invalid and a recent updated_at (within cooldown)
    await globalDb.run(
      "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
      [ALICE, "handle.invalid", "alice display", Date.now() - 10 * 60 * 1000], // 10 minutes ago
    );

    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.renewed.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    // Should NOT fetch — cooldown hasn't elapsed
    expect(getProfiles).toHaveBeenCalledTimes(0);
    expect(
      (await globalDb
        .query("select handle from profiles where did = ?")
        .get<{ handle: string }>(ALICE))?.handle,
    ).toBe("handle.invalid");
  });

  test("re-fetches an existing row older than the freshness TTL", async () => {
    // A *valid* (non-handle.invalid) row older than PROFILE_REFRESH_TTL_MS
    // must be re-fetched, so a display-name/avatar change on the PDS
    // propagates instead of pinning the first-fetched values forever.
    const { globalDb } = freshGlobal();
    await globalDb.run(
      "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
      // 2 hours ago — past the 30-minute refresh TTL.
      [ALICE, "alice.test", "old display", Date.now() - 2 * 60 * 60 * 1000],
    );

    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    // Should fetch despite a valid handle, because the row is TTL-stale.
    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);
    // The refreshed name/avatar replace the stale values.
    expect(
      (await globalDb
        .query("select name from profiles where did = ?")
        .get<{ name: string }>(ALICE))?.name,
    ).toBe("alice.test display");
  });

  test("does NOT re-fetch an existing row within the freshness TTL", async () => {
    const { globalDb } = freshGlobal();
    await globalDb.run(
      "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
      // 10 minutes ago — within the 30-minute refresh TTL.
      [ALICE, "alice.test", "alice display", Date.now() - 10 * 60 * 1000],
    );

    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    // Fresh row, valid handle — no fetch.
    expect(getProfiles).toHaveBeenCalledTimes(0);
    expect(
      (await globalDb
        .query("select name from profiles where did = ?")
        .get<{ name: string }>(ALICE))?.name,
    ).toBe("alice display");
  });
});

describe("defaultGetProfiles", () => {
  const realFetch = globalThis.fetch;

  // The fetcher backs off DIDs it cannot resolve, so each test starts from a
  // clean cache — otherwise an earlier test's misses suppress a later test's
  // expected request.
  beforeEach(() => {
    _resetProfileNegativeCache();
  });

  // Restore the real fetch after each test so we never leak the mock into
  // other tests in the same file/process.
  afterEach(() => {
    globalThis.fetch = realFetch;
    _resetProfileNegativeCache();
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

describe("global profile store", () => {
  test("insertProfilesWithExtras writes the global profiles table", async () => {
    const { insertProfilesWithExtras } = await import("./profiles.ts");
    const { globalDb } = freshGlobal();

    const p = profileFor(ALICE, "alice.test");
    await insertProfilesWithExtras(openDb(), [p], new Map());

    const row = await globalDb
      .query("select did, handle, name, avatar from profiles where did = ?")
      .get(ALICE);
    expect(row).not.toBeNull();
    expect(row?.handle).toBe("alice.test");
    expect(row?.name).toBe("alice.test display");
    expect(row?.avatar).toBe("https://cdn.example/alice.test.png");
  });

  test("writeSetUserProfileToGlobal updates the global profile", async () => {
    const { writeSetUserProfileToGlobal } = await import("./profiles.ts");
    const { globalDb } = freshGlobal();

    await writeSetUserProfileToGlobal({
      did: BOB,
      name: "Bob",
      avatar: "https://cdn.example/bob.png",
      extensions: {
        "space.roomy.extension.discordUserOrigin.v0": { handle: "bob#1234" },
      },
    });

    const row = await globalDb
      .query("select did, handle, name, avatar from profiles where did = ?")
      .get(BOB);
    expect(row).not.toBeNull();
    expect(row?.handle).toBe("bob#1234");
    expect(row?.name).toBe("Bob");
    expect(row?.avatar).toBe("https://cdn.example/bob.png");
  });

  test("Bluesky re-fetch refreshes display fields (null-preserving merge)", async () => {
    // A re-fetched profile must update a name/avatar that changed on the PDS,
    // so the merge is null-preserving rather than first-writer-wins (a NULL
    // still never clobbers an existing value). The profile-refresh TTL is what
    // drives the re-fetch.
    const { insertProfilesWithExtras } = await import("./profiles.ts");
    const { globalDb } = freshGlobal();

    // First fetch pins an old name/avatar (extras empty → Bluesky path).
    await insertProfilesWithExtras(
      openDb(),
      [profileFor(ALICE, "alice.test")],
      new Map(),
    );
    const before = await globalDb
      .query("select name, avatar from profiles where did = ?")
      .get<{ name: string | null; avatar: string | null }>(ALICE);
    expect(before?.name).toBe("alice.test display");

    // Second fetch returns a changed name/avatar (new CID-bearing URL).
    const refreshed = {
      did: ALICE,
      handle: "alice.test",
      displayName: "Alice Renewed",
      avatar: "https://cdn.example/alice-renewed.png",
    } as unknown as ProfileViewDetailed;
    await insertProfilesWithExtras(openDb(), [refreshed], new Map());

    const after = await globalDb
      .query("select name, avatar, handle from profiles where did = ?")
      .get<{ name: string | null; avatar: string | null; handle: string | null }>(ALICE);
    expect(after?.name).toBe("Alice Renewed");
    expect(after?.avatar).toBe("https://cdn.example/alice-renewed.png");
    // Handle preserved across the merge.
    expect(after?.handle).toBe("alice.test");
  });

  test("Bluesky merge never clobbers an existing value with a NULL", async () => {
    const { insertProfilesWithExtras } = await import("./profiles.ts");
    const { globalDb } = freshGlobal();

    await insertProfilesWithExtras(
      openDb(),
      [profileFor(ALICE, "alice.test")],
      new Map(),
    );
    // A sparse Bluesky response with no displayName/avatar must not wipe them.
    const sparse = {
      did: ALICE,
      handle: "alice.other.test",
    } as unknown as ProfileViewDetailed;
    await insertProfilesWithExtras(openDb(), [sparse], new Map());

    const row = await globalDb
      .query("select name, avatar, handle from profiles where did = ?")
      .get<{ name: string | null; avatar: string | null; handle: string | null }>(ALICE);
    expect(row?.name).toBe("alice.test display");
    expect(row?.avatar).toBe("https://cdn.example/alice.test.png");
  });

  test("Roomy record without a handle does not clobber an existing handle", async () => {
    const { insertProfilesWithExtras } = await import("./profiles.ts");
    const { globalDb } = freshGlobal();

    // Seed a Bluesky-sourced profile with a real handle first.
    await insertProfilesWithExtras(
      openDb(),
      [profileFor(ALICE, "alice.test")],
      new Map(),
    );

    // Now a Roomy record arrives (extras present) but carries no handle —
    // Roomy profile records don't store a handle. This must NOT wipe the
    // handle already on the row.
    const roomyProfile = {
      did: ALICE,
      displayName: "Alice Roomy",
    } as unknown as ProfileViewDetailed;
    await insertProfilesWithExtras(
      openDb(),
      [roomyProfile],
      new Map([[ALICE, { pronouns: "she/her" }]]),
    );

    const row = await globalDb
      .query("select did, handle, name from profiles where did = ?")
      .get(ALICE);
    expect(row?.handle).toBe("alice.test");
    expect(row?.name).toBe("Alice Roomy");
  });

  test("an empty-string handle from a Roomy record never lands in the column", async () => {
    // `happyViewToProfileView` coerces a missing handle to `""`, so a
    // Roomy-sourced profile reaches this writer with `handle: ""`. Stored as
    // is, `""` is a *present* value and would survive every
    // `coalesce(..., profiles.handle)` merge — the row could never pick up a
    // real handle, and `getProfile` would return `handle: ""` forever. The
    // writer must normalize `""` to NULL.
    const { insertProfilesWithExtras } = await import("./profiles.ts");
    const { globalDb } = freshGlobal();

    await insertProfilesWithExtras(
      openDb(),
      [{ did: ALICE, handle: "", displayName: "Alice Roomy" } as ProfileViewDetailed],
      new Map([[ALICE, { pronouns: "she/her" }]]),
    );

    const row = await globalDb
      .query("select handle, name from profiles where did = ?")
      .get<{ handle: string | null; name: string | null }>(ALICE);
    expect(row?.handle).toBeNull();
    expect(row?.name).toBe("Alice Roomy");
  });

  test("a legacy '' handle self-heals to the next real handle", async () => {
    // A row holding `''` must recover on the next write, without a migration.
    const { insertProfilesWithExtras } = await import("./profiles.ts");
    const { globalDb } = freshGlobal();

    await globalDb.run(
      "insert into profiles (did, handle, name) values (?, ?, ?)",
      [ALICE, "", "Alice Roomy"],
    );

    await insertProfilesWithExtras(
      openDb(),
      [profileFor(ALICE, "alice.test")],
      new Map(),
    );

    const row = await globalDb
      .query("select handle from profiles where did = ?")
      .get<{ handle: string | null }>(ALICE);
    expect(row?.handle).toBe("alice.test");
  });

  test("a Roomy record leaves a legacy '' as NULL rather than keeping ''", async () => {
    const { insertProfilesWithExtras } = await import("./profiles.ts");
    const { globalDb } = freshGlobal();

    await globalDb.run(
      "insert into profiles (did, handle, name) values (?, ?, ?)",
      [ALICE, "", "Alice Old"],
    );

    await insertProfilesWithExtras(
      openDb(),
      [{ did: ALICE, displayName: "Alice Roomy" } as unknown as ProfileViewDetailed],
      new Map([[ALICE, {}]]),
    );

    const row = await globalDb
      .query("select handle, name from profiles where did = ?")
      .get<{ handle: string | null; name: string | null }>(ALICE);
    expect(row?.handle).toBeNull();
    expect(row?.name).toBe("Alice Roomy");
  });
});

describe("handle-less HappyView profiles", () => {
  test("happyViewToProfileView leaves a missing handle undefined, not ''", async () => {
    const { happyViewToProfileView } = await import("./roomyProfile.ts");
    const pv = happyViewToProfileView({
      did: ALICE,
      displayName: "Alice Roomy",
      avatar: "atblob://x/y",
    });
    expect(pv.handle).toBeUndefined();
    expect(pv.displayName).toBe("Alice Roomy");
  });

  test("getProfilesRoomyFirst merges the Bluesky handle onto the Roomy record", async () => {
    // A Roomy-record user's handle is publicly resolvable but HappyView can't
    // supply it (Roomy records carry no handle), and the Bluesky fallback only
    // covers DIDs HappyView did NOT have. The handle has to be merged onto the
    // Roomy profile.
    const realFetch = globalThis.fetch;
    const prevNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV; // defeat the test-mode short-circuit
    const { getProfilesRoomyFirst } = await import("./profiles.ts");
    const { setHappyView } = await import("../happyview.ts");
    try {
      setHappyView({
        endpoint: "https://happyview.test",
        clientKey: "hvc_test",
      });
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).includes("happyview.test")) {
          // HappyView has the Roomy record — display fields, no handle.
          return Response.json({
            profiles: [
              { did: ALICE, displayName: "Alice Roomy", pronouns: "she/her" },
            ],
          });
        }
        // Bluesky knows the handle.
        return Response.json({
          profiles: [{ did: ALICE, handle: "alice.test" }],
        });
      }) as unknown as typeof globalThis.fetch;

      const { profiles, extras } = await getProfilesRoomyFirst(
        [ALICE],
        { endpoint: "https://happyview.test", clientKey: "hvc_test" },
      );

      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.did).toBe(ALICE);
      expect(profiles[0]?.handle).toBe("alice.test");
      expect(profiles[0]?.displayName).toBe("Alice Roomy");
      expect(extras.get(ALICE)).toEqual({ pronouns: "she/her" });
    } finally {
      globalThis.fetch = realFetch;
      setHappyView(null);
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });
});

describe("profile fetch negative cache", () => {
  // The appview fetch is what a DID with no Roomy record and no Bluesky
  // profile costs. Under `bun test` the pipeline's Bluesky leg is skipped, so
  // these tests drive `defaultGetProfiles` — the one function every profile
  // lookup goes through — against a mocked `fetch`.
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    _resetProfileNegativeCache();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    _resetProfileNegativeCache();
  });

  /** A mocked appview that resolves ALICE only; `calls` counts requests. */
  function mockAppview(): { calls: number } {
    const counter = { calls: 0 };
    globalThis.fetch = (async (_url: string | URL | Request) => {
      counter.calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ profiles: [profileFor(ALICE, "alice.test")] }),
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    return counter;
  }

  test("an unresolved DID is not re-fetched, a resolved one still is", async () => {
    const appview = mockAppview();

    await defaultGetProfiles([ALICE, BOB]);
    expect(appview.calls).toBe(1);

    // BOB resolved to nothing, so this fetch is skipped outright rather than
    // being issued again on every event.
    const second = await defaultGetProfiles([BOB]);
    expect(second).toEqual([]);
    expect(appview.calls).toBe(1);

    // ALICE resolved, so she is not backed off.
    await defaultGetProfiles([ALICE]);
    expect(appview.calls).toBe(2);
  });

  test("a DID with no profile is retried once the backoff elapses", async () => {
    const appview = mockAppview();
    await defaultGetProfiles([BOB]);
    expect(appview.calls).toBe(1);

    setSystemTime(Date.now() + 61 * 1000);
    try {
      await defaultGetProfiles([BOB]);
    } finally {
      setSystemTime();
    }
    expect(appview.calls).toBe(2);
  });

  test("backs off an appview error, not just an empty result", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 503 } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    await defaultGetProfiles([BOB]);
    await defaultGetProfiles([BOB]);
    expect(calls).toBe(1);
  });

  test("materialisation skips a backed-off author instead of re-running the pipeline", async () => {
    const { globalDb } = freshGlobal();
    const appview = mockAppview();

    // First event from BOB: the pipeline runs and resolves nothing.
    await ensureProfilesForBatch(globalDb, [decodedAs(joinSpaceEvent(), 1, BOB)], defaultGetProfiles);
    expect(appview.calls).toBe(1);

    // Second event from BOB: no fetch at all.
    await ensureProfilesForBatch(globalDb, [decodedAs(joinSpaceEvent(), 2, BOB)], defaultGetProfiles);
    expect(appview.calls).toBe(1);
  });

  test("a backed-off DID recovers once its profile becomes resolvable", async () => {
    const { globalDb } = freshGlobal();
    let resolvable = false;
    globalThis.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () =>
          resolvable ? { profiles: [profileFor(BOB, "bob.test")] } : { profiles: [] },
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    await ensureProfilesForBatch(globalDb, [decodedAs(joinSpaceEvent(), 1, BOB)], defaultGetProfiles);
    expect(
      await globalDb.query("select did from profiles where did = ?").get(BOB),
    ).toBeNull();

    resolvable = true;
    setSystemTime(Date.now() + 61 * 1000);
    try {
      await ensureProfilesForBatch(globalDb, [decodedAs(joinSpaceEvent(), 2, BOB)], defaultGetProfiles);
    } finally {
      setSystemTime();
    }
    expect(
      (await globalDb
        .query("select handle from profiles where did = ?")
        .get<{ handle: string }>(BOB))?.handle,
    ).toBe("bob.test");
  });
});
