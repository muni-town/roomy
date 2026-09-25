/**
 * space.roomy.user.getProfile coverage. In test mode HappyView isn't
 * configured, so getProfile reads the global `profiles` table (the
 * authoritative Roomy profile store). Seed a row there and assert it's
 * returned.
 *
 * The last two tests configure HappyView and stub `globalThis.fetch` so they
 * exercise the Roomy-record branch of the handler without touching the network.
 *
 * Run: bun test --cwd packages/appserver src/e2e/profileEndpoints.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { startAppserver, type E2eContext } from "./helpers.ts";
import { setHappyView } from "../happyview.ts";
import { _setTestGetRoomyProfileRecord } from "../materialization/roomyProfile.ts";

const USER = "did:plc:e2e-user";
const HAPPYVIEW = { endpoint: "https://happyview.test", clientKey: "hvc_test" };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setHappyView(null);
});

/**
 * Stub the two outbound profile sources in-process, passing everything else
 * (in particular the test's own HTTP calls to the appserver) through to the
 * real transport.
 */
function stubProfileSources(opts: {
  happyView?: Record<string, unknown>[];
  bluesky?: Record<string, unknown>[];
}): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("happyview.test")) {
      return Response.json({ profiles: opts.happyView ?? [] });
    }
    if (url.includes("bsky.app")) {
      return Response.json({ profiles: opts.bluesky ?? [] });
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
}

/** The routed handle `startAppserver` returns, narrowed to the global DB. */
type GlobalWriter = {
  global(): { run(sql: string, ...params: unknown[]): Promise<unknown> };
};

function seedProfile(
  ctx: E2eContext,
  did: string,
  handle: string | null,
): Promise<unknown> {
  // The E2eContext types `db` as bun:sqlite's Database; at runtime it is the
  // pool router that exposes `global()` (see helpers.ts).
  const writer = ctx.db as unknown as GlobalWriter;
  return writer
    .global()
    .run("insert or replace into profiles (did, handle, name) values (?, ?, ?)", [
      did,
      handle,
      "Roomy Name",
    ]);
}

async function readStoredHandle(
  ctx: E2eContext,
  did: string,
): Promise<string | null> {
  const reader = ctx.db as unknown as {
    global(): {
      query(sql: string): { get<T>(...p: unknown[]): Promise<T | null> };
    };
  };
  const row = await reader
    .global()
    .query("select handle from profiles where did = ?")
    .get<{ handle: string | null }>(did);
  return row?.handle ?? null;
}

async function getProfile(ctx: E2eContext, actor: string) {
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.user.getProfile?actor=${actor}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("space.roomy.user.getProfile", () => {
  test("returns a seeded global profile for a DID", async () => {
    const ctx = await startAppserver();
    await (ctx.db as unknown as { global(): { run(s: string, ...p: unknown[]): Promise<unknown> } })
      .global()
      .run(
        "insert or ignore into profiles (did, handle, name, avatar) values (?, ?, ?, ?)",
        [USER, "user.test", "Test User", "https://cdn.example/u.png"],
      );

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.user.getProfile?actor=${USER}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("did", USER);
    expect(body).toHaveProperty("handle", "user.test");
    expect(body).toHaveProperty("displayName", "Test User");
  });

  test("returns minimal profile (just did) for an unknown user", async () => {
    const ctx = await startAppserver();
    const unknown = "did:plc:unknown-user";
    // getProfile will try Bluesky hydration for an unknown DID; that network
    // call fails gracefully and returns the minimal { did } shape. Guard the
    // assertion to the did only.
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.user.getProfile?actor=${unknown}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("did", unknown);
  });

  test("resolves the handle when only a Roomy record exists (no stored handle)", async () => {
    // The user's only profile source is a Roomy record (HappyView), which
    // carries no handle, and the global row is either absent or holds an
    // empty string. Bluesky knows the handle — it must be resolved and
    // persisted.
    // startAppserver() initialises the HappyView singleton from the env, so
    // the test config and fetch stub must be installed *after* it starts.
    const ctx = await startAppserver();
    setHappyView(HAPPYVIEW);
    stubProfileSources({
      happyView: [
        {
          did: USER,
          displayName: "Test User",
          avatar: `atblob://${USER}/bafy`,
        },
      ],
      bluesky: [{ did: USER, handle: "test-user.roomy.chat" }],
    });
    await seedProfile(ctx, USER, "");

    const body = await getProfile(ctx, USER);

    expect(body.did).toBe(USER);
    expect(body.handle).toBe("test-user.roomy.chat");
    // The Roomy record stays authoritative for display fields.
    expect(body.displayName).toBe("Test User");
    // Persisted: the empty row value is replaced by the resolved handle.
    expect(await readStoredHandle(ctx, USER)).toBe("test-user.roomy.chat");
  });

  test("serves the PDS record over a stale HappyView snapshot (read-after-write)", async () => {
    // Read-after-write consistency. The write path confirms the record on
    // the PDS, but HappyView is Jetstream-fed and can lag a just-confirmed
    // write; re-materialising that snapshot into the global row would serve
    // the stale pre-write fields and clobber the row. The PDS is
    // authoritative and consulted first.
    const ctx = await startAppserver();
    setHappyView(HAPPYVIEW);
    // Fresh, just-written record on the PDS (post-putRecord).
    _setTestGetRoomyProfileRecord(async () => ({
      displayName: "Fresh Name",
      description: "edited just now",
      pronouns: "they/them",
      website: "https://fresh.example",
    }));
    // HappyView still serves the pre-write snapshot (Jetstream lag).
    stubProfileSources({
      happyView: [
        {
          did: USER,
          displayName: "Stale Name",
          description: "old description",
          pronouns: "she/her",
          website: "https://stale.example",
        },
      ],
      bluesky: [{ did: USER, handle: "user.test" }],
    });
    await seedProfile(ctx, USER, "user.test");

    const body = await getProfile(ctx, USER);

    // The just-confirmed PDS write is immediately visible.
    expect(body.displayName).toBe("Fresh Name");
    expect(body.description).toBe("edited just now");
    expect(body.pronouns).toBe("they/them");
    expect(body.website).toBe("https://fresh.example");
    expect(body.handle).toBe("user.test");
    // The stale HappyView snapshot must not clobber the global row.
    const reader = ctx.db as unknown as {
      global(): {
        query(sql: string): { get<T>(...p: unknown[]): Promise<T | null> };
      };
    };
    const stored = await reader
      .global()
      .query("select name from profiles where did = ?")
      .get<{ name: string | null }>(USER);
    expect(stored?.name).toBe("Fresh Name");
  });

  test("never returns an empty-string handle", async () => {
    // Same shape, but Bluesky doesn't know the DID either: the handle must be
    // *absent* from the response, never `""` (which the lexicon models as a
    // present string and renders as a blank `@`).
    const ctx = await startAppserver();
    setHappyView(HAPPYVIEW);
    stubProfileSources({
      happyView: [{ did: USER, displayName: "Test User" }],
      bluesky: [],
    });
    await seedProfile(ctx, USER, "");

    const body = await getProfile(ctx, USER);

    expect(body.did).toBe(USER);
    expect(body.handle).toBeUndefined();
    expect("handle" in body).toBe(false);
  });
});
