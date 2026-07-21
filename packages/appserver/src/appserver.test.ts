import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppserver, type AppserverHandle } from "./appserver.ts";
import { testAuthVerifier } from "./xrpc/auth.ts";
import { closeDb } from "./db/db.ts";
import { _resetHydrationInflight } from "./hydration/userHydration.ts";
import { _resetEmbedSweeper } from "./embed/sweeper.ts";

// Pick a free port by letting the OS assign one (port 0).
function ephemeralPort(): number {
  // Bun.serve with port 0 binds to an ephemeral port.
  return 0;
}

let handle: AppserverHandle | null = null;

beforeEach(() => {
  // Reset all process-wide singletons so each test gets a clean appserver.
  closeDb();
  _resetHydrationInflight();
  _resetEmbedSweeper();
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

describe("createAppserver factory", () => {
  test("starts, serves health + did.json, and stops cleanly", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      ownDid: "did:web:test.example",
      serviceEndpoint: "http://test.example",
    });

    const base = `http://localhost:${handle.port}`;

    // /health returns ok with the configured DID
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody.status).toBe("ok");
    expect(healthBody.did).toBe("did:web:test.example");

    // /.well-known/did.json returns the DID document
    const didDoc = await fetch(`${base}/.well-known/did.json`);
    expect(didDoc.status).toBe(200);
    const didBody = await didDoc.json();
    expect(didBody.id).toBe("did:web:test.example");
    expect(didBody.service[0].serviceEndpoint).toBe("http://test.example");

  });

  test("getConnectionTicket works with test auth header", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      disableEmbedSweeper: true,
    });

    const base = `http://localhost:${handle.port}`;

    // Without X-Test-Did → 401 (anonymous, getConnectionTicket requires auth)
    const noAuth = await fetch(
      `${base}/xrpc/space.roomy.auth.getConnectionTicket`,
      { method: "POST", body: "{}" },
    );
    expect(noAuth.status).toBe(401);

    // With X-Test-Did → 200 + ticket
    const authed = await fetch(
      `${base}/xrpc/space.roomy.auth.getConnectionTicket`,
      {
        method: "POST",
        body: "{}",
        headers: { "X-Test-Did": "did:plc:test-user" },
      },
    );
    expect(authed.status).toBe(200);
    const ticketBody = await authed.json();
    expect(typeof ticketBody.ticket).toBe("string");
    expect(ticketBody.ticket.length).toBeGreaterThan(0);
  });

  test("getSpaces returns empty list for anonymous caller (no hydration)", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      disableEmbedSweeper: true,
    });

    const base = `http://localhost:${handle.port}`;

    // Anonymous (no X-Test-Did) → empty spaces list without calling Leaf.
    // Authenticated callers trigger hydrateUserMembership which needs Leaf,
    // so we test the anonymous path here; the authenticated path requires a
    // Leaf backend and is covered by integration tests.
    const res = await fetch(
      `${base}/xrpc/space.roomy.space.getSpaces?includeLeft=false`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spaces).toEqual([]);
  });

  test("CORS headers are present on responses", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      disableEmbedSweeper: true,
      corsOrigin: "https://app.test",
    });

    const base = `http://localhost:${handle.port}`;

    // OPTIONS preflight
    const preflight = await fetch(`${base}/xrpc/space.roomy.space.getSpaces`, {
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.test",
    );
    // X-Test-Id must be in allowed headers for browser-based e2e
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
      "X-Test-Did",
    );
  });

  test("unknown NSID returns 404 MethodNotFound", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      disableEmbedSweeper: true,
    });

    const base = `http://localhost:${handle.port}`;

    const res = await fetch(`${base}/xrpc/space.roomy.nonexistent`, {
      headers: { "X-Test-Did": "did:plc:test-user" },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("MethodNotFound");
  });
});

// ─── Query response cache integration ───────────────────────────────────

import { openDb } from "./db/db.ts";
import { Router as InvalidationRouter } from "./invalidation/index.ts";
import type { QueryNsid } from "./invalidation/types.ts";
import type { UserDid } from "@roomy-space/sdk";

/**
 * Seed a minimal space + personal-stream cache row into the process-wide DB
 * (opened by createAppserver) so getMetadata returns 200 without hitting the
 * network. Must be called AFTER createAppserver has opened the singleton DB.
 */
function seedMinimalSpace(spaceId: string, userDid: string): void {
  const db = openDb();
  // Space entity + comp_space + comp_info.
  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [spaceId, spaceId]);
  db.run(
    `insert or ignore into comp_space (entity, handle, allow_public_join, allow_member_invites)
     values (?, ?, ?, ?)`,
    [spaceId, null, null, 1],
  );
  db.run(
    `insert or ignore into comp_info (entity, name) values (?, ?)`,
    [spaceId, "Cache Test Space"],
  );
  db.run(
    `update comp_space set sidebar_config = '{}' where entity = ?`,
    [spaceId],
  );
  // User entity + personal-stream cache so hydrateUserMembership doesn't
  // try to resolve the DID via PLC (which has no server in tests).
  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [userDid, userDid]);
  db.run(
    `insert or ignore into comp_user_personal_stream (user_did, personal_stream_did, resolved_at)
     values (?, ?, ?)`,
    [userDid, userDid, 0],
  );
}

describe("query response cache", () => {
  test("getMetadata: second call is a cache hit, invalidation causes re-fetch", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      disableEmbedSweeper: true,
    });
    seedMinimalSpace("did:web:cache-test.space", "did:plc:user1");
    const base = `http://localhost:${handle.port}`;
    const headers = { "X-Test-Did": "did:plc:user1" };
    const url = `${base}/xrpc/space.roomy.space.getMetadata?spaceId=did:web:cache-test.space`;

    expect(handle.queryCache).toBeDefined();
    const cache = handle.queryCache!;

    // First call: miss → handler runs → response cached.
    const res1 = await fetch(url, { headers });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.name).toBe("Cache Test Space");
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(0);
    expect(cache.stats.size).toBe(1);

    // Second call: hit → cached response returned, handler does not run.
    const res2 = await fetch(url, { headers });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2).toEqual(body1);
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(1);

    // Emit a broadcast invalidation → entry evicted.
    const router = InvalidationRouter.getInstance()!;
    router.emit([
      {
        kind: "queryInvalidation",
        signal: { nsid: "space.roomy.space.getMetadata" as QueryNsid, params: { spaceId: "did:web:cache-test.space" } },
      },
    ]);
    expect(cache.stats.size).toBe(0);

    // Third call: miss again → handler re-runs.
    const res3 = await fetch(url, { headers });
    expect(res3.status).toBe(200);
    const body3 = await res3.json();
    expect(body3.name).toBe("Cache Test Space");
    expect(cache.stats.misses).toBe(2);
  });

  test("per-user invalidation does not evict another user's entry", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      disableEmbedSweeper: true,
    });
    seedMinimalSpace("did:web:cache-test.space", "did:plc:user1");
    // Also seed user2's personal stream (the space entity already exists).
    {
      const db = openDb();
      db.run("insert or ignore into entities (id, stream_id) values (?, ?)", ["did:plc:user2", "did:plc:user2"]);
      db.run(
        `insert or ignore into comp_user_personal_stream (user_did, personal_stream_did, resolved_at) values (?, ?, ?)`,
        ["did:plc:user2", "did:plc:user2", 0],
      );
    }
    const base = `http://localhost:${handle.port}`;
    const url = `${base}/xrpc/space.roomy.space.getMetadata?spaceId=did:web:cache-test.space`;
    const cache = handle.queryCache!;

    // Two users fetch the same space.
    await fetch(url, { headers: { "X-Test-Did": "did:plc:user1" } });
    await fetch(url, { headers: { "X-Test-Did": "did:plc:user2" } });
    expect(cache.stats.size).toBe(2);

    // Per-user invalidation for user1 only.
    const router = InvalidationRouter.getInstance()!;
    router.emit([
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getMetadata" as QueryNsid,
          params: { spaceId: "did:web:cache-test.space" },
          affectedUser: "did:plc:user1" as UserDid,
        },
      },
    ]);

    // user1's entry evicted, user2's retained.
    expect(cache.stats.size).toBe(1);

    // user1 re-fetches (miss), user2 still cached (hit).
    const res1 = await fetch(url, { headers: { "X-Test-Did": "did:plc:user1" } });
    expect(res1.status).toBe(200);
    expect(cache.stats.misses).toBeGreaterThanOrEqual(3);

    const res2 = await fetch(url, { headers: { "X-Test-Did": "did:plc:user2" } });
    expect(res2.status).toBe(200);
    // user2 should be a hit.
    const hitsAfter = cache.stats.hits;
    expect(hitsAfter).toBeGreaterThan(0);
  });

  test("disableQueryCache option turns off caching", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      disableEmbedSweeper: true,
      disableQueryCache: true,
    });
    seedMinimalSpace("did:web:cache-test.space", "did:plc:user1");
    expect(handle.queryCache).toBeUndefined();

    const base = `http://localhost:${handle.port}`;
    const url = `${base}/xrpc/space.roomy.space.getMetadata?spaceId=did:web:cache-test.space`;
    const headers = { "X-Test-Did": "did:plc:user1" };

    // Two calls both hit the handler (no cache).
    const res1 = await fetch(url, { headers });
    const res2 = await fetch(url, { headers });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const b1 = await res1.json();
    const b2 = await res2.json();
    expect(b1).toEqual(b2);
  });
  test("/health/cache reports cache metrics", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      disableEmbedSweeper: true,
    });
    seedMinimalSpace("did:web:cache-test.space", "did:plc:user1");

    const base = `http://localhost:${handle.port}`;
    const url = `${base}/xrpc/space.roomy.space.getMetadata?spaceId=did:web:cache-test.space`;
    const headers = { "X-Test-Did": "did:plc:user1" };

    // One request → one miss, size 1.
    await fetch(url, { headers });

    const res = await fetch(`${base}/health/cache`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.misses).toBe(1);
    expect(body.hits).toBe(0);
    expect(body.size).toBe(1);
  });
});