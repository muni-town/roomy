/**
 * E2E tests for the admin dashboard queries:
 *   space.roomy.admin.getDashboardStats  (aggregate overview)
 *   space.roomy.admin.listSpaces         (paginated, sorted by member count)
 *
 * Run: bun test --cwd packages/appserver src/e2e/dashboard.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  startAppserver,
  seedSpace,
  seedUser,
  type E2eContext,
} from "./helpers.ts";
import { _setAdminDids } from "../admin.ts";

const ADMIN = "did:plc:e2e-admin";
const USER_A = "did:plc:e2e-user-a";

const USER_B = "did:plc:e2e-user-b";
const USER_C = "did:plc:e2e-user-c";

_setAdminDids([ADMIN]);

// Each test gets a fresh events DB file so seeded events don't collide on the
// (stream_id, idx) unique key across tests. `startAppserver` resets the main
// in-memory DB but the events DB is a separate file that persists without this.
let eventsDbPath = "";
beforeEach(() => {
  eventsDbPath = `/tmp/roomy-dashboard-${Math.random().toString(36).slice(2, 8)}.sqlite`;
  process.env.EVENTS_DB_PATH = eventsDbPath;
});
afterEach(() => {
  delete process.env.EVENTS_DB_PATH;
  try {
    Bun.$`rm -f ${eventsDbPath}`.quiet();
  } catch {
    // ignore
  }
});

/** Insert one event row into the attached events DB. */
function seedEvent(
  ctx: E2eContext,
  streamId: string,
  idx: number,
  eventType: string,
  createdAt: number,
): void {
  ctx.db.run(
    `insert into events.stream_events (stream_id, idx, user, payload, signature, event_type, created_at)
     values (?, ?, ?, x'', x'', ?, ?)`,
    [streamId, idx, USER_A, eventType, createdAt],
  );
}

/** Seed entities for the three test users so membership FKs resolve. */
function seedUsers(ctx: E2eContext): void {
  for (const u of [USER_A, USER_B, USER_C]) seedUser(ctx.db, u);
}

/** Seed a bare space (no built-in membership) so member counts are exact. */
function seedBareSpace(ctx: E2eContext, spaceId: string, name: string): void {
  ctx.db.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [spaceId, spaceId],
  );
  ctx.db.run(
    "insert or ignore into comp_space (entity) values (?)",
    [spaceId],
  );
  ctx.db.run(
    "insert or ignore into comp_info (entity, name) values (?, ?)",
    [spaceId, name],
  );
}

/** Seed a forward membership edge (head=space, tail=user) — the direction
 * the member-count query reads (`edges where head=space and label='member'`). */
function addMember(ctx: E2eContext, spaceId: string, userDid: string): void {
  ctx.db.run(
    `insert or ignore into edges (head, tail, label) values (?, ?, 'member')`,
    [spaceId, userDid],
  );
}

// ─── space.roomy.admin.getDashboardStats ─────────────────────────────────

describe("space.roomy.admin.getDashboardStats", () => {
  test("admin → aggregate activity + system, no per-space array", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db, "did:web:space-a.example", USER_A);

    const now = Date.now();
    seedEvent(ctx, "did:web:space-a.example", 0, "space.roomy.message.createMessage.v0", now);
    seedEvent(ctx, "did:web:space-a.example", 1, "space.roomy.reaction.addReaction.v0", now);

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.getDashboardStats`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.activity).toBeDefined();
    expect(body.activity.totalEvents).toBe(2);
    expect(body.activity.eventsToday).toBe(2);
    expect(body.activity.activeSpaces).toBe(1);
    expect(body.activity.connectedUsers).toBeTypeOf("number");

    expect(body.system).toBeDefined();
    expect(body.system.appserverDid).toBeTypeOf("string");
    expect(body.system.uptime).toBeGreaterThanOrEqual(0);
    expect(body.system.pushVapidConfigured).toBeTypeOf("boolean");
    expect(body.system.pushTotalSubscriptions).toBeGreaterThanOrEqual(0);

    // The per-space array was split out into listSpaces.
    expect(body.spaces).toBeUndefined();
  });

  test("anonymous → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.getDashboardStats`,
    );
    expect(res.status).toBe(403);
  });

  test("non-admin → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER_A)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.getDashboardStats`,
    );
    expect(res.status).toBe(403);
  });
});

// ─── space.roomy.admin.listSpaces ────────────────────────────────────────

describe("space.roomy.admin.listSpaces", () => {
  test("sorted by member count desc, includes breakdown", async () => {
    const ctx = await startAppserver();
    seedUsers(ctx);

    // Space C has the most members → should appear first.
    seedBareSpace(ctx, "did:web:space-c.example", "Space C");
    addMember(ctx, "did:web:space-c.example", USER_A);
    addMember(ctx, "did:web:space-c.example", USER_B);
    addMember(ctx, "did:web:space-c.example", USER_C);

    // Space A has one member → should appear last.
    seedBareSpace(ctx, "did:web:space-a.example", "Space A");
    addMember(ctx, "did:web:space-a.example", USER_A);

    // Space B has two members → middle.
    seedBareSpace(ctx, "did:web:space-b.example", "Space B");
    addMember(ctx, "did:web:space-b.example", USER_A);
    addMember(ctx, "did:web:space-b.example", USER_B);

    const now = Date.now();
    seedEvent(ctx, "did:web:space-c.example", 0, "space.roomy.message.createMessage.v0", now);
    seedEvent(ctx, "did:web:space-c.example", 1, "space.roomy.reaction.addReaction.v0", now);
    seedEvent(ctx, "did:web:space-c.example", 2, "space.roomy.message.createMessage.v0", now);

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces?limit=50`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.spaces).toHaveLength(3);
    expect(body.cursor).toBeUndefined(); // all fit in one page

    const [first, second, third] = body.spaces;
    expect(first.did).toBe("did:web:space-c.example");
    expect(first.memberCount).toBe(3);
    expect(first.name).toBe("Space C");
    expect(first.totalEvents).toBe(3);
    expect(first.eventBreakdown["space.roomy.message.createMessage.v0"]).toBe(2);
    expect(first.eventBreakdown["space.roomy.reaction.addReaction.v0"]).toBe(1);

    expect(second.did).toBe("did:web:space-b.example");
    expect(second.memberCount).toBe(2);

    expect(third.did).toBe("did:web:space-a.example");
    expect(third.memberCount).toBe(1);
  });
  test("pagination: limit + cursor returns the next page", async () => {
    const ctx = await startAppserver();
    seedUsers(ctx);

    // Seed 3 spaces with distinct member counts so the sort is unambiguous.
    seedBareSpace(ctx, "did:web:s3.example", "S3");
    addMember(ctx, "did:web:s3.example", USER_A);
    addMember(ctx, "did:web:s3.example", USER_B);
    addMember(ctx, "did:web:s3.example", USER_C);

    seedBareSpace(ctx, "did:web:s2.example", "S2");
    addMember(ctx, "did:web:s2.example", USER_A);
    addMember(ctx, "did:web:s2.example", USER_B);

    seedBareSpace(ctx, "did:web:s1.example", "S1");
    addMember(ctx, "did:web:s1.example", USER_A);

    // Page 1: limit 2 → S3, S2 + cursor.
    const res1 = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces?limit=2`,
    );
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.spaces.map((s: { did: string }) => s.did)).toEqual([
      "did:web:s3.example",
      "did:web:s2.example",
    ]);
    expect(body1.cursor).toBeDefined();

    // Page 2: pass the cursor → S1, no further cursor.
    const res2 = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces?limit=2&cursor=${encodeURIComponent(body1.cursor)}`,
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.spaces.map((s: { did: string }) => s.did)).toEqual([
      "did:web:s1.example",
    ]);
    expect(body2.cursor).toBeUndefined();
  });

  test("empty DB → empty spaces array, no cursor", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spaces).toEqual([]);
    expect(body.cursor).toBeUndefined();
  });

  test("anonymous → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces`,
    );
    expect(res.status).toBe(403);
  });

  test("non-admin → 403", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER_A)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces`,
    );
    expect(res.status).toBe(403);
  });

  test("malformed cursor → treated as first page (degrades gracefully)", async () => {
    const ctx = await startAppserver();
    seedUsers(ctx);
    seedBareSpace(ctx, "did:web:s1.example", "S1");
    addMember(ctx, "did:web:s1.example", USER_A);

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces?cursor=not-a-valid-cursor`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spaces).toHaveLength(1);
  });
});