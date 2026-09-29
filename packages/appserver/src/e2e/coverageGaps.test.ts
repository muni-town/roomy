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
import { PUSH_TRANSPORTS } from "../push/transports/types.ts";

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

  test("a subscription whose transport can't send is reported skipped, not delivered", async () => {
    const ctx = await startAppserver();
    // A skip is a transport declining to attempt delivery. Web Push declines
    // only while VAPID is unset, and this suite boots with a keypair, so the
    // declining transport is installed directly.
    const realWebPush = PUSH_TRANSPORTS.webpush;
    PUSH_TRANSPORTS.webpush = {
      kind: "webpush",
      isConfigured: () => false,
      async deliver() {
        return { outcome: "skipped", status: null };
      },
    };
    readStateDb(ctx.db).run(
      "insert into push_subscriptions (user_did, endpoint, kind, p256dh, auth, expiration_time) values (?, ?, 'webpush', '', '', null)",
      [USER, "https://push.example/e2e-skip"],
    );

    try {
      const res = await ctx.authedFetch(ADMIN)(`${ctx.baseUrl}/xrpc/space.roomy.admin.push.testSend`, {
        method: "POST",
        body: JSON.stringify({ did: USER }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const result = body.results.find((r: { endpoint: string }) => r.endpoint.endsWith("e2e-skip"));
      expect(result.status).toBeNull();
      // An unconfigured pipeline attempted nothing; reporting it as a delivery
      // is what makes this diagnostic lie about why a user sees no notifications.
      expect(result.skipped).toBe(true);
      expect(result.gone).toBe(false);
    } finally {
      PUSH_TRANSPORTS.webpush = realWebPush!;
    }
  });

  test("a subscription naming a transport this build doesn't know is reported as an error", async () => {
    const ctx = await startAppserver();
    readStateDb(ctx.db).run(
      "insert into push_subscriptions (user_did, endpoint, kind, p256dh, auth, expiration_time) values (?, ?, 'windows-wns', '', '', null)",
      [USER, "device-token-e2e-absent"],
    );

    const res = await ctx.authedFetch(ADMIN)(`${ctx.baseUrl}/xrpc/space.roomy.admin.push.testSend`, {
      method: "POST",
      body: JSON.stringify({ did: USER }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const result = body.results.find(
      (r: { endpoint: string }) => r.endpoint === "device-token-e2e-absent",
    );
    expect(result.error).toContain("No transport registered");
    expect(result.skipped).toBe(false);
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
