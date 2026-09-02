import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppserver, type AppserverHandle } from "./appserver.ts";
import { testAuthVerifier } from "./xrpc/auth.ts";
import { closeDb } from "./db/db.ts";
import { _resetHydrationInflight } from "./hydration/userHydration.ts";
import { _resetEmbedSweeper } from "./embed/sweeper.ts";
import { _resetProfileStoreCache } from "./queries/profileStore.ts";

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
  _resetProfileStoreCache();
  // Use a temp data dir so the DID-doc test's signing key lands in /tmp,
  // not the real data dir.
  process.env.DATA_DIR = "/tmp/appserver-test-data";
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
      disableBackgroundWorkers: true,
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
    // The DID doc exposes the appserver's signing key as a Multikey
    // verification method so the arbiter can validate self-signed serviceAuth
    // tokens against it.
    expect(didBody.verificationMethod).toHaveLength(1);
    expect(didBody.verificationMethod[0].id).toBe("did:web:test.example#atproto");
    expect(didBody.verificationMethod[0].type).toBe("Multikey");
    expect(didBody.verificationMethod[0].publicKeyMultibase).toMatch(/^z/);

  });

  test("/metrics exposes Prometheus text format with core families", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      ownDid: "did:web:test.example",
      serviceEndpoint: "http://test.example",
      disableBackgroundWorkers: true,
    });

    const base = `http://localhost:${handle.port}`;

    // Hit a real endpoint so the request counter/histogram have a sample.
    await fetch(`${base}/health`);

    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();

    // Core families present in Prometheus text exposition format.
    for (const name of [
      "roomy_xrpc_requests_total",
      "roomy_xrpc_request_duration_seconds",
      "roomy_pool_size",
      "roomy_pool_worker_pending",
      "roomy_cache_hits_total",
      "roomy_embed_pending",
      "roomy_db_timeouts_total",
    ]) {
      expect(body).toContain(`# TYPE ${name}`);
    }
    // The /health hit should have been recorded as a request.
    expect(body).toContain('endpoint="/health"');
    expect(body).toContain('method="GET"');
  });

  test("getConnectionTicket works with test auth header", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      disableBackgroundWorkers: true,
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
      disableBackgroundWorkers: true,
    });

    const base = `http://localhost:${handle.port}`;

    // Anonymous (no X-Test-Did) → empty spaces list without a remote event backend.
    // Authenticated callers trigger hydrateUserMembership which needs a remote event backend,
    // so we test the anonymous path here; the authenticated path requires a
    // remote event backend and is covered by integration tests.
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
      disableBackgroundWorkers: true,
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
      disableBackgroundWorkers: true,
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
 * Seed a minimal space + user entity into the process-wide DB (opened by
 * createAppserver) so getMetadata returns 200 without hitting the network.
 * Must be called AFTER createAppserver has opened the singleton DB.
 */
function seedMinimalSpace(spaceId: string, userDid: string): void {
  const sp = openDb().forSpace(spaceId);
  // Space entity + comp_space + comp_info (per-space DB).
  sp.run("insert or ignore into entities (id, stream_id) values (?, ?)", [spaceId, spaceId]);
  sp.run(
    `insert or ignore into comp_space (entity, allow_public_join, allow_member_invites)
     values (?, ?, ?)`,
    [spaceId, null, 1],
  );
  sp.run(
    `insert or ignore into comp_info (entity, name) values (?, ?)`,
    [spaceId, "Cache Test Space"],
  );
  sp.run(
    `update comp_space set sidebar_config = '{}' where entity = ?`,
    [spaceId],
  );
  // User entity so hydrateUserMembership has an FK target for joinedSpace
  // edges without trying to resolve the DID via PLC (no server in tests).
  sp.run("insert or ignore into entities (id, stream_id) values (?, ?)", [userDid, userDid]);
}

describe("query response cache", () => {
  test("getMetadata: second call is a cache hit, invalidation causes re-fetch", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      disableBackgroundWorkers: true,
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
      disableBackgroundWorkers: true,
    });
    seedMinimalSpace("did:web:cache-test.space", "did:plc:user1");
    // Also seed user2's entity (the space entity already exists).
    {
      openDb().forSpace("did:web:cache-test.space").run(
        "insert or ignore into entities (id, stream_id) values (?, ?)",
        ["did:plc:user2", "did:plc:user2"],
      );
    }
    const base = `http://localhost:${handle.port}`;
    const url = `${base}/xrpc/space.roomy.space.getMetadata?spaceId=did:web:cache-test.space`;
    const cache = handle.queryCache!;

    // Two users fetch the same space. Check the requests actually succeeded
    // before asserting cache state — a transient handler failure would
    // otherwise surface as a confusing size mismatch instead of a 500.
    const r1 = await fetch(url, { headers: { "X-Test-Did": "did:plc:user1" } });
    expect(r1.status).toBe(200);
    const r2 = await fetch(url, { headers: { "X-Test-Did": "did:plc:user2" } });
    expect(r2.status).toBe(200);
    // Per-user keys: each user's first fetch is a miss and both entries are
    // stored (user1's entry does not satisfy user2's request).
    expect(cache.stats.misses).toBe(2);
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
      disableBackgroundWorkers: true,
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
      disableBackgroundWorkers: true,
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

  test("/health/pool reports per-worker pool stats", async () => {
    handle = await createAppserver({
      port: ephemeralPort(),
      authVerifier: testAuthVerifier,
      dbPath: ":memory:",
      readStateDbPath: ":memory:",
      quiet: true,
      disableBackgroundWorkers: true,
    });

    const base = `http://localhost:${handle.port}`;
    const res = await fetch(`${base}/health/pool`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.size).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.spaceWorkers)).toBe(true);
    expect(body.spaceWorkers.length).toBe(body.size);
    expect(body.systemWorker).toBeDefined();
  });
});