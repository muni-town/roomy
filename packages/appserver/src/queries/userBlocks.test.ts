/**
 * Tests for the block set (`queries/userBlocks.ts`) and the PDS fetch behind it
 * (`materialization/blocks.ts`).
 *
 * Two layers are exercised separately, because they fail differently:
 *
 *   - The **fetch** is driven against a stub PDS over real HTTP, so the union of
 *     the two collections, the page loop and the unknown-collection answer are
 *     the real code paths. Those are properties of the wire, not of the cache.
 *   - The **cache, the refresh trigger and the mutual relation** run against
 *     the fetcher override (`_setTestFetchBlockRecords`), so their timing is
 *     observable instead of being buried in a network round-trip.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { UserDid } from "@roomy-space/sdk";
import { closeDb, openDb, openReadStateDb } from "../db/db.ts";
import { idResolver } from "../identity.ts";
import { _setTestFetchBlockRecords, fetchBlockRecords } from "../materialization/blocks.ts";
import {
  _blockRefreshesInFlight,
  _resetBlockCaches,
  blocks,
  blockedBy,
  hiddenBy,
  refreshBlockSet,
  warmBlockSet,
} from "./userBlocks.ts";

const ALICE = UserDid.assert("did:plc:alice");
const BOB = UserDid.assert("did:plc:bob");
const CAROL = UserDid.assert("did:plc:carol");
const DAVE = UserDid.assert("did:plc:dave");

const originalTtl = process.env.BLOCK_CACHE_TTL_MS;
const originalBackoff = process.env.BLOCK_ERROR_BACKOFF_MS;

beforeEach(async () => {
  closeDb();
  openDb({ path: ":memory:" });
  _resetBlockCaches();
  _setTestFetchBlockRecords(null);
  // The DID-document cache is process-wide and long-lived, so a test that stubs
  // a DID's document would otherwise pass or fail on whether an earlier test had
  // already resolved that DID for real.
  await idResolver.did.cache?.clear();
});

afterEach(() => {
  _setTestFetchBlockRecords(null);
  _resetBlockCaches();
  closeDb();
  if (originalTtl === undefined) delete process.env.BLOCK_CACHE_TTL_MS;
  else process.env.BLOCK_CACHE_TTL_MS = originalTtl;
  if (originalBackoff === undefined) delete process.env.BLOCK_ERROR_BACKOFF_MS;
  else process.env.BLOCK_ERROR_BACKOFF_MS = originalBackoff;
});

/** Every block row for `userDid`, as `blocked_did:source`. */
async function storedRows(userDid: UserDid): Promise<string[]> {
  const rows = await openReadStateDb()
    .query("select blocked_did, source from user_blocks where user_did = ? order by blocked_did")
    .all<{ blocked_did: string; source: string }>([userDid]);
  return rows.map((r) => `${r.blocked_did}:${r.source}`);
}

/** The recorded refresh attempt for `userDid`, or null. */
async function fetchStamp(
  userDid: UserDid,
): Promise<{ fetched_at: number; status: string } | null> {
  return openReadStateDb()
    .query("select fetched_at, status from user_block_fetches where user_did = ?")
    .get<{ fetched_at: number; status: string }>([userDid]);
}

// ─── The PDS fetch, over real HTTP ─────────────────────────────────────────

/** One block record in a stub page, in the `listRecords` envelope. */
function stubRecord(subject: string, createdAt = "2026-01-01T00:00:00.000Z") {
  return {
    uri: `at://did:plc:stub/space.roomy.user.block/${subject}`,
    cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    value: { subject, createdAt },
  };
}

/** One `listRecords` page, as a PDS would answer it. */
interface StubPage {
  records: ReturnType<typeof stubRecord>[];
  cursor?: string;
}

/**
 * A stub PDS. `pages` maps a collection to the successive pages the pager will
 * be served; a collection absent from the map answers `{records: []}`, and a
 * `Response` value is returned verbatim so a test can serve a 400.
 */
function stubPds(
  pages: Record<string, Array<StubPage | Response>>,
): { url: string; requests: string[]; stop: () => void } {
  const requests: string[] = [];
  const seen = new Map<string, number>();
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      const collection = url.searchParams.get("collection") ?? "";
      requests.push(collection);
      const page = pages[collection];
      if (!page) return Response.json({ records: [] });
      const index = seen.get(collection) ?? 0;
      seen.set(collection, index + 1);
      const entry = page[Math.min(index, page.length - 1)];
      if (entry instanceof Response) return entry;
      return Response.json(entry ?? { records: [] });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/**
 * Point `did`'s DID document at `pdsUrl` for the duration of one test.
 *
 * The DID document is the only thing stubbed: the record call itself goes over
 * real HTTP to the stub PDS, so the request shape, the page loop and the error
 * handling are all the production code.
 */
function stubDidDocument(did: string, pdsUrl: string): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("plc.directory")) {
      return Response.json({
        id: did,
        service: [
          {
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: pdsUrl,
          },
        ],
      });
    }
    return realFetch(input as never, init);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe("fetchBlockRecords", () => {
  test("unifies both collections and follows the cursor to the end of the repo", async () => {
    const pds = stubPds({
      "space.roomy.user.block": [
        { records: [stubRecord(BOB)], cursor: "page-2" },
        { records: [stubRecord(CAROL, "2026-01-02T00:00:00.000Z")] },
      ],
      "app.bsky.graph.block": [
        { records: [stubRecord(DAVE, "2025-12-31T00:00:00.000Z")] },
      ],
    });
    const restore = stubDidDocument(ALICE, pds.url);
    try {
      const records = await fetchBlockRecords(ALICE);
      const bySubject = new Map(records.map((r) => [r.subject, r]));
      expect(bySubject.size).toBe(3);
      expect(bySubject.get(BOB)?.source).toBe("roomy");
      expect(bySubject.get(CAROL)?.source).toBe("roomy");
      expect(bySubject.get(DAVE)?.source).toBe("bluesky");
      // Both pages of the Roomy collection were read.
      expect(pds.requests.filter((c) => c === "space.roomy.user.block")).toHaveLength(2);
    } finally {
      restore();
      pds.stop();
    }
  });

  test("an account that has blocked nobody yields an empty set, not an error", async () => {
    const pds = stubPds({});
    const restore = stubDidDocument(ALICE, pds.url);
    try {
      expect(await fetchBlockRecords(ALICE)).toEqual([]);
    } finally {
      restore();
      pds.stop();
    }
  });

  test("a PDS that refuses the unknown Roomy collection still returns the Bluesky blocks", async () => {
    const pds = stubPds({
      "space.roomy.user.block": [
        Response.json(
          { error: "InvalidRequest", message: "Unknown collection: space.roomy.user.block" },
          { status: 400 },
        ),
      ],
      "app.bsky.graph.block": [
        { records: [stubRecord(DAVE, "2025-12-31T00:00:00.000Z")] },
      ],
    });
    const restore = stubDidDocument(ALICE, pds.url);
    try {
      const records = await fetchBlockRecords(ALICE);
      expect(records.map((r) => r.subject)).toEqual([DAVE]);
      expect(records[0]?.source).toBe("bluesky");
    } finally {
      restore();
      pds.stop();
    }
  });

  test("the fetched set is what a read serves, both collections included", async () => {
    const pds = stubPds({
      "space.roomy.user.block": [{ records: [stubRecord(BOB)] }],
      "app.bsky.graph.block": [{ records: [stubRecord(CAROL)] }],
    });
    const restore = stubDidDocument(ALICE, pds.url);
    try {
      expect(await refreshBlockSet(ALICE)).toBe(true);
      expect(await storedRows(ALICE)).toEqual([`${BOB}:roomy`, `${CAROL}:bluesky`]);
      expect((await fetchStamp(ALICE))?.status).toBe("ok");
      expect([...(await blocks(ALICE))].sort()).toEqual([BOB, CAROL].sort());
    } finally {
      restore();
      pds.stop();
    }
  });

  /**
   * The fetch is a third-party call on a read path, so it must give up rather
   * than hang. The DID document is served (pointing at the black hole) so that
   * resolution succeeds and the *record* call is what the deadline bounds.
   */
  test("the PDS record fetch returns instead of hanging", async () => {
    const originalTimeout = process.env.PROFILE_FETCH_TIMEOUT_MS;
    process.env.PROFILE_FETCH_TIMEOUT_MS = "150";
    const hole = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    const restore = stubDidDocument(ALICE, `http://127.0.0.1:${hole.port}`);
    try {
      const outcome = await Promise.race([
        fetchBlockRecords(ALICE).then(
          () => "returned" as const,
          () => "rejected" as const,
        ),
        // A generous ceiling: the point is that a deadline exists and fires,
        // not its exact value.
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 4000)),
      ]);
      expect(outcome).not.toBe("hung");
    } finally {
      restore();
      hole.stop(true);
      if (originalTimeout === undefined) delete process.env.PROFILE_FETCH_TIMEOUT_MS;
      else process.env.PROFILE_FETCH_TIMEOUT_MS = originalTimeout;
    }
  });
});

// ─── The refresh trigger, its backoff, and the mutual relation ─────────────

describe("the refresh trigger", () => {
  test("a read starts no fetch, however cold the cache", async () => {
    let calls = 0;
    _setTestFetchBlockRecords(async () => {
      calls++;
      return [{ subject: BOB, source: "roomy", createdAt: null }];
    });

    // Nothing has ever been stored for ALICE or BOB: no rows, no stamp.
    expect([...(await blocks(ALICE))]).toEqual([]);
    expect([...(await blockedBy(ALICE))]).toEqual([]);
    expect([...(await hiddenBy(ALICE))]).toEqual([]);
    expect([...(await hiddenBy(BOB))]).toEqual([]);
    await Promise.all(_blockRefreshesInFlight());

    expect(calls).toBe(0);
  });

  test("an authenticated request refreshes the account's own set", async () => {
    _setTestFetchBlockRecords(async () => [
      { subject: BOB, source: "roomy", createdAt: null },
    ]);

    warmBlockSet(ALICE);
    await Promise.all(_blockRefreshesInFlight());

    expect([...(await blocks(ALICE))]).toEqual([BOB]);
    expect((await fetchStamp(ALICE))?.status).toBe("ok");
  });

  /**
   * The trigger sits on a request path, so it returns before the fetch it starts
   * does: a PDS that never answers must not hold up the request that warmed it.
   */
  test("the trigger returns before the fetch it starts", async () => {
    const gate = Promise.withResolvers<void>();
    _setTestFetchBlockRecords(async () => {
      await gate.promise;
      return [{ subject: BOB, source: "roomy", createdAt: null }];
    });

    warmBlockSet(ALICE);
    expect([...(await blocks(ALICE))]).toEqual([]);

    gate.resolve();
    await Promise.all(_blockRefreshesInFlight());
    expect([...(await blocks(ALICE))]).toEqual([BOB]);
  });

  test("a failed fetch is recorded as an error and backs off instead of retrying per request", async () => {
    let calls = 0;
    _setTestFetchBlockRecords(async () => {
      calls++;
      throw new Error("PDS unreachable");
    });

    warmBlockSet(ALICE);
    await Promise.all(_blockRefreshesInFlight());

    expect((await fetchStamp(ALICE))?.status).toBe("error");
    expect(calls).toBe(1);

    // Requests inside the backoff window do not retry the failed fetch.
    warmBlockSet(ALICE);
    await Promise.all(_blockRefreshesInFlight());
    warmBlockSet(ALICE);
    await Promise.all(_blockRefreshesInFlight());
    expect(calls).toBe(1);
  });

  test("a failure does not erase the blocks already known", async () => {
    _setTestFetchBlockRecords(async () => [
      { subject: BOB, source: "roomy", createdAt: null },
    ]);
    await refreshBlockSet(ALICE);
    expect([...(await blocks(ALICE))]).toEqual([BOB]);

    // A later refresh that cannot reach the PDS keeps the rows it had: an empty
    // set would stop hiding an author the user has blocked.
    _setTestFetchBlockRecords(async () => {
      throw new Error("PDS unreachable");
    });
    await refreshBlockSet(ALICE);
    expect([...(await blocks(ALICE))]).toEqual([BOB]);
    expect((await fetchStamp(ALICE))?.status).toBe("error");
  });

  test("the stamp expires and the next request refreshes", async () => {
    process.env.BLOCK_CACHE_TTL_MS = "40";
    let calls = 0;
    _setTestFetchBlockRecords(async () => {
      calls++;
      return [{ subject: BOB, source: "roomy", createdAt: null }];
    });

    warmBlockSet(ALICE);
    await Promise.all(_blockRefreshesInFlight());
    expect(calls).toBe(1);

    // Inside the window an authenticated request costs nothing.
    warmBlockSet(ALICE);
    await Promise.all(_blockRefreshesInFlight());
    expect(calls).toBe(1);

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(60);
      warmBlockSet(ALICE);
      await Promise.all(_blockRefreshesInFlight());
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a refresh picks up a block whose rows were not there before", async () => {
    await refreshBlockSet(ALICE);
    expect([...(await blocks(ALICE))]).toEqual([]);

    _setTestFetchBlockRecords(async () => [
      { subject: BOB, source: "bluesky", createdAt: null },
    ]);
    await refreshBlockSet(ALICE);
    expect([...(await blocks(ALICE))]).toEqual([BOB]);

    // And a refresh drops a block that was removed in another client.
    _setTestFetchBlockRecords(async () => []);
    await refreshBlockSet(ALICE);
    expect([...(await blocks(ALICE))]).toEqual([]);
  });
});

describe("hiddenBy", () => {
  test("an anonymous viewer hides nobody and reads nothing", async () => {
    expect([...(await hiddenBy(null))]).toEqual([]);
  });

  test("the viewer's own blocks are hidden from them", async () => {
    _setTestFetchBlockRecords(async () => [
      { subject: BOB, source: "roomy", createdAt: null },
      { subject: CAROL, source: "bluesky", createdAt: null },
    ]);
    await refreshBlockSet(ALICE);
    expect([...(await hiddenBy(ALICE))].sort()).toEqual([BOB, CAROL].sort());
  });

  /**
   * The mutual case. B's own repos hold nothing at all, so `blocks(B)` is empty
   * and the only evidence of the block lives in A's repo — which is why the row
   * that answers `blockedBy(B)` is written by A's refresh and never by B's read.
   */
  test("a blocker is hidden from the account they blocked, with nothing in that account's own repos", async () => {
    // A holds a block naming B; B's repos hold nothing.
    _setTestFetchBlockRecords(async (did) =>
      did === ALICE
        ? [{ subject: BOB, source: "roomy", createdAt: null }]
        : [],
    );

    // B's read learns nothing: nobody has been read yet.
    expect([...(await hiddenBy(BOB))]).toEqual([]);

    // A is present, so A's own request reads A's repo — and that is what writes
    // the row B's reverse lookup answers from.
    warmBlockSet(ALICE);
    await Promise.all(_blockRefreshesInFlight());

    expect([...(await hiddenBy(BOB))]).toEqual([ALICE]);
    // A's own view is unchanged: they blocked B, and B blocked nobody.
    expect([...(await hiddenBy(ALICE))]).toEqual([BOB]);
  });

  /**
   * The reverse set is built from ATProto repos, so a bridged author holds no
   * repo to block from and can never be the *blocker*. One that reaches the
   * refresh path anyway — a DID that does not resolve — records the failure and
   * leaves the request that triggered it standing.
   */
  test("a refresh for an unresolvable DID records the failure instead of throwing", async () => {
    const BRIDGED = "did:discord:123456789012345678" as UserDid;
    _setTestFetchBlockRecords(async (did) => {
      if (did === BRIDGED) throw new Error("no DID document for a bridged author");
      return [];
    });

    warmBlockSet(BRIDGED);
    await Promise.all(_blockRefreshesInFlight());

    expect((await fetchStamp(BRIDGED))?.status).toBe("error");
    expect([...(await hiddenBy(CAROL))]).toEqual([]);
  });

  test("the reverse set is read from the same table the forward set is written to", async () => {
    _setTestFetchBlockRecords(async () => [
      { subject: BOB, source: "roomy", createdAt: null },
    ]);
    await refreshBlockSet(ALICE);

    // One table, two directions: A's written rows answer `blockedBy(B)`.
    expect(await storedRows(ALICE)).toEqual([`${BOB}:roomy`]);
    expect([...(await hiddenBy(BOB))]).toEqual([ALICE]);
  });
});
