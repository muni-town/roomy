/**
 * E2E coverage for endpoints that were registered but had no HTTP-level test:
 *   - space.roomy.getFlags (user-facing)
 *   - space.roomy.space.getSpaceSummary
 *   - space.roomy.embed.getLinkMetadata
 *   - space.roomy.admin.push.getStats
 *   - space.roomy.admin.push.testSend
 *   - space.roomy.sync.getEvents
 *
 * Run: bun test --cwd packages/appserver src/e2e/coverageGaps.test.ts
 */

import { describe, expect, test } from "bun:test";
import { startAppserver, seedSpace, seedJoinedSpace, readStateDb } from "./helpers.ts";
import { _setAdminDids } from "../admin.ts";

const USER = "did:plc:e2e-user";
const ADMIN = "did:plc:e2e-admin";
const SPACE = "did:web:space-gaps.example";

_setAdminDids([ADMIN]);

describe("space.roomy.getFlags (user-facing)", () => {
  test("returns enabled flags for the caller", async () => {
    const ctx = await startAppserver();
    // Enable the "search" flag globally in the read-state DB.
    readStateDb(ctx.db).run(
      "insert into feature_flags (key, global_enabled, updated_at) values ('search', 1, ?)",
      [Date.now()],
    );

    const res = await ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/space.roomy.getFlags`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).toContain("search");
  });

  test("anonymous → 401", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(`${ctx.baseUrl}/xrpc/space.roomy.getFlags`);
    expect(res.status).toBe(401);
  });
});

describe("space.roomy.space.getSpaceSummary", () => {
  test("returns the space name for a member", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db, SPACE, USER);
    seedJoinedSpace(ctx.db, USER, SPACE);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaceSummary?spaceId=${encodeURIComponent(SPACE)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Test Space");
  });

  test("unknown space → 404", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaceSummary?spaceId=${encodeURIComponent("did:web:nope.example")}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("space.roomy.embed.getLinkMetadata", () => {
  test("returns 200 (empty object when the fetch yields no metadata)", async () => {
    const ctx = await startAppserver();
    // Hermetic: no network. fetchLinkMetadata returns null → handler returns {}.
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.embed.getLinkMetadata?url=${encodeURIComponent("https://example.com")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe("object");
  });

  test("missing url → 400", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(`${ctx.baseUrl}/xrpc/space.roomy.embed.getLinkMetadata`);
    expect(res.status).toBe(400);
  });
});

describe("space.roomy.admin.push.getStats", () => {
  test("returns push stats for an admin", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(ADMIN)(`${ctx.baseUrl}/xrpc/space.roomy.admin.push.getStats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.vapidConfigured).toBe("boolean");
    expect(typeof body.totalSubscriptions).toBe("number");
  });

  test("non-admin → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/space.roomy.admin.push.getStats`);
    expect(res.status).toBe(403);
  });
});

describe("space.roomy.admin.push.testSend", () => {
  test("returns 200 for an admin (no subscriptions → empty results)", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(ADMIN)(`${ctx.baseUrl}/xrpc/space.roomy.admin.push.testSend`, {
      method: "POST",
      body: JSON.stringify({ did: USER }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
  });

  test("non-admin → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/space.roomy.admin.push.testSend`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});

describe("space.roomy.sync.getEvents", () => {
  test("returns 200 with an empty event list for an admin", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.sync.getEvents?streamDid=${encodeURIComponent(SPACE)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
  });

  test("non-admin → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.sync.getEvents?streamDid=${encodeURIComponent(SPACE)}`,
    );
    expect(res.status).toBe(403);
  });
});
