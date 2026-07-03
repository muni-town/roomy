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