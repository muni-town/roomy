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
  seedMembershipIntent,
  type E2eContext,
} from "./helpers.ts";
import { _setAdminDids } from "../admin.ts";

const ADMIN = "did:plc:e2e-admin";
const USER_A = "did:plc:e2e-user-a";

const USER_B = "did:plc:e2e-user-b";
const USER_C = "did:plc:e2e-user-c";

_setAdminDids([ADMIN]);

// Each test gets a fresh in-memory DB via `startAppserver` (which opens the
// event-log DB in-memory), so seeded events don't collide across tests.
beforeEach(() => {
  // no-op — startAppserver resets the in-memory DB each test
});
afterEach(() => {
  // no-op
});

/**
 * Insert one event row into the event-log DB (ctx.db IS the event-log DB).
 *
 * Also advances `stream_state`, exactly as `StreamManager.sendEvents` does: it
 * is the only writer in production, so a test that seeds the log by hand has to
 * keep the same invariant (`latest_event` = the highest `idx`) for the rollup
 * the dashboard reads to agree with the rows seeded here.
 */
function seedEvent(
  ctx: E2eContext,
  streamId: string,
  idx: number,
  eventType: string,
  createdAt: number,
): void {
  ctx.db.run(
    `insert into stream_events (stream_id, idx, user, payload, signature, event_type, created_at)
     values (?, ?, ?, x'', x'', ?, ?)`,
    [streamId, idx, USER_A, eventType, createdAt],
  );
  ctx.db.run(
    `insert into stream_state (stream_id, latest_event) values (?, ?)
     on conflict (stream_id) do update set latest_event = max(latest_event, excluded.latest_event)`,
    [streamId, idx],
  );
}

/** Seed entities for the three test users so membership FKs resolve. */
function seedUsers(ctx: E2eContext): void {
  for (const u of [USER_A, USER_B, USER_C]) seedUser(ctx.db, u);
}

/** Routed per-space handle for seeding materialised rows. Writes are
 * fire-and-forget; attach a no-op catch (matching `helpers.ts`'s
 * `swallowDropped`) so a write still in flight when `afterEach` closes the
 * DB isn't reported as an unhandled rejection (bun exits 1). */
function spaceDb(ctx: E2eContext, spaceId: string) {
  const sp = (ctx.db as unknown as { forSpace(did: string): { run(sql: string, ...p: unknown[]): Promise<unknown> } }).forSpace(spaceId);
  return {
    run(sql: string, ...p: unknown[]) {
      const prom = sp.run(sql, ...p);
      prom.catch(() => {});
      return prom;
    },
  };
}

/** Seed a bare space (no built-in membership) so member counts are exact. */
function seedBareSpace(ctx: E2eContext, spaceId: string, name: string): void {
  const sp = spaceDb(ctx, spaceId);
  sp.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [spaceId, spaceId],
  );
  sp.run(
    "insert or ignore into comp_space (entity) values (?)",
    [spaceId],
  );
  sp.run(
    "insert or ignore into comp_info (entity, name) values (?, ?)",
    [spaceId, name],
  );
}

/** Seed a forward membership edge (head=space, tail=user) — the direction
 * the member-count query reads (`edges where head=space and label='member'`).
 * Also seeds the user entity in the per-space DB so the edge FK resolves. */
function addMember(ctx: E2eContext, spaceId: string, userDid: string): void {
  const sp = spaceDb(ctx, spaceId);
  sp.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [userDid, userDid],
  );
  sp.run(
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
    // No membership edges seeded → nobody has ever joined.
    expect(body.activity.totalUsers).toBe(0);

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

  test("counts each user once across their spaces, including departed ones", async () => {
    const ctx = await startAppserver();

    // USER_A holds memberships in two spaces; USER_B joined one and left it.
    // A count that ignored the 'left' state — or that read a distinct count
    // over (user, space) pairs rather than over users — would report 3 or 1
    // here instead of 2.
    seedMembershipIntent(ctx.db, USER_A, "did:web:s1.example", "joined");
    seedMembershipIntent(ctx.db, USER_A, "did:web:s2.example", "joined");
    seedMembershipIntent(ctx.db, USER_B, "did:web:s1.example", "left");

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.getDashboardStats`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // USER_A twice-over is still one user; USER_B counts despite leaving.
    expect(body.activity.totalUsers).toBe(2);
  });
});


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
    // Every space needs at least one event to appear in listSpaces (the
    // handler enumerates spaces from the event-log stream_events table).
    seedEvent(ctx, "did:web:space-a.example", 0, "space.roomy.message.createMessage.v0", now);
    seedEvent(ctx, "did:web:space-b.example", 0, "space.roomy.message.createMessage.v0", now);
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

    // Every space needs at least one event to appear in listSpaces.
    const now = Date.now();
    seedEvent(ctx, "did:web:s1.example", 0, "space.roomy.message.createMessage.v0", now);
    seedEvent(ctx, "did:web:s2.example", 0, "space.roomy.message.createMessage.v0", now);
    seedEvent(ctx, "did:web:s3.example", 0, "space.roomy.message.createMessage.v0", now);

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

  test("sort param: totalEvents and eventsToday order by that key", async () => {
    const ctx = await startAppserver();
    seedUsers(ctx);

    // Three spaces with distinct member/event shapes so each sort key
    // yields a different (unambiguous) order:
    //   S1: 1 member, 5 total events, 0 today
    //   S2: 3 members, 2 total events, 4 today
    //   S3: 2 members, 4 total events, 1 today
    seedBareSpace(ctx, "did:web:s1.example", "S1");
    addMember(ctx, "did:web:s1.example", USER_A);
    seedBareSpace(ctx, "did:web:s2.example", "S2");
    addMember(ctx, "did:web:s2.example", USER_A);
    addMember(ctx, "did:web:s2.example", USER_B);
    addMember(ctx, "did:web:s2.example", USER_C);
    seedBareSpace(ctx, "did:web:s3.example", "S3");
    addMember(ctx, "did:web:s3.example", USER_A);
    addMember(ctx, "did:web:s3.example", USER_B);

    const now = Date.now();
    const yesterday = now - 86_400_000;
    // S1: 5 events, all yesterday → 5 total, 0 today.
    for (let i = 0; i < 5; i++) {
      seedEvent(ctx, "did:web:s1.example", i, "space.roomy.message.createMessage.v0", yesterday);
    }
    // S2: 2 events yesterday + 4 today → 6 total, 4 today.
    seedEvent(ctx, "did:web:s2.example", 0, "space.roomy.message.createMessage.v0", yesterday);
    seedEvent(ctx, "did:web:s2.example", 1, "space.roomy.message.createMessage.v0", yesterday);
    for (let i = 2; i < 6; i++) {
      seedEvent(ctx, "did:web:s2.example", i, "space.roomy.message.createMessage.v0", now);
    }
    // S3: 3 events yesterday + 1 today → 4 total, 1 today.
    for (let i = 0; i < 3; i++) {
      seedEvent(ctx, "did:web:s3.example", i, "space.roomy.message.createMessage.v0", yesterday);
    }
    seedEvent(ctx, "did:web:s3.example", 3, "space.roomy.message.createMessage.v0", now);

    // totalEvents desc: S2(6), S1(5), S3(4).
    const resTotal = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces?limit=50&sort=totalEvents`,
    );
    expect(resTotal.status).toBe(200);
    const totalBody = await resTotal.json();
    expect(totalBody.spaces.map((s: { did: string; totalEvents: number }) => s.did)).toEqual([
      "did:web:s2.example",
      "did:web:s1.example",
      "did:web:s3.example",
    ]);
    expect(totalBody.spaces.map((s: { totalEvents: number }) => s.totalEvents)).toEqual([6, 5, 4]);

    // eventsToday desc: S2(4), S3(1), S1(0).
    const resToday = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces?limit=50&sort=eventsToday`,
    );
    expect(resToday.status).toBe(200);
    const todayBody = await resToday.json();
    expect(todayBody.spaces.map((s: { did: string }) => s.did)).toEqual([
      "did:web:s2.example",
      "did:web:s3.example",
      "did:web:s1.example",
    ]);
    expect(todayBody.spaces.map((s: { eventsToday: number }) => s.eventsToday)).toEqual([4, 1, 0]);

    // memberCount (default) is unchanged.
    const resMember = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces?limit=50`,
    );
    const memberBody = await resMember.json();
    expect(memberBody.spaces.map((s: { did: string }) => s.did)).toEqual([
      "did:web:s2.example",
      "did:web:s3.example",
      "did:web:s1.example",
    ]);
  });

  test.each([
    "memberCount",
    "totalEvents",
    "eventsToday",
  ] as const)("pagination under sort=%s returns each space exactly once (no dupes, no gaps)", async (sort) => {
    const ctx = await startAppserver();
    seedUsers(ctx);

    // Six spaces with deliberately overlapping values on every sort key so
    // tie-breaking + cursor consistency are actually exercised (not a
    // trivial distinct-key case). Member counts 0–3 with repeats; event
    // volumes chosen to collide across spaces.
    const spaces = [
      // [did-suffix, memberCount, totalEvents, eventsToday]
      ["s1", 3, 10, 5],
      ["s2", 1, 12, 2],
      ["s3", 2, 10, 8],
      ["s4", 0, 15, 3],
      ["s5", 3, 8, 5],
      ["s6", 2, 12, 8],
    ] as const;

    const now = Date.now();
    const yesterday = now - 86_400_000;
    for (const [suffix, members, total, today] of spaces) {
      const did = `did:web:${suffix}.example`;
      seedBareSpace(ctx, did, `S${suffix.toUpperCase()}`);
      for (let m = 0; m < members; m++) {
        addMember(ctx, did, [USER_A, USER_B, USER_C][m]!);
      }
      const todayEvts = Math.min(today, total);
      for (let i = 0; i < todayEvts; i++) {
        seedEvent(ctx, did, i, "space.roomy.message.createMessage.v0", now);
      }
      for (let i = todayEvts; i < total; i++) {
        seedEvent(ctx, did, i, "space.roomy.message.createMessage.v0", yesterday);
      }
    }

    // Page through with limit=2 collecting every space + the values we
    // expect to see in descending order per sort key.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const q = new URLSearchParams({ limit: "2", sort });
      if (cursor) q.set("cursor", cursor);
      const res = await ctx.authedFetch(ADMIN)(
        `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces?${q.toString()}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const s of body.spaces as Array<{ did: string }>) seen.push(s.did);
      if (body.cursor === undefined) break;
      cursor = body.cursor;
    }

    // Every space appears exactly once.
    expect(seen).toHaveLength(spaces.length);
    expect(new Set(seen).size).toBe(spaces.length);

    // And the collected order is exactly the sort key's descending order
    // (ties broken by DID ascending), proving no gaps/dupes across pages.
    const val = (suffix: string) => {
      const row = spaces.find((s) => `did:web:${s[0]}.example` === suffix)!;
      return sort === "memberCount" ? row[1] : sort === "totalEvents" ? row[2] : row[3];
    };
    const expected = [...spaces]
      .map((s) => `did:web:${s[0]}.example`)
      .sort((a, b) => {
        const dv = val(b) - val(a);
        return dv !== 0 ? dv : a < b ? -1 : a > b ? 1 : 0;
      });
    expect(seen).toEqual(expected);
  });

  test("invalid sort → 400", async () => {
    const ctx = await startAppserver();
    seedUsers(ctx);
    seedBareSpace(ctx, "did:web:s1.example", "S1");
    seedEvent(ctx, "did:web:s1.example", 0, "space.roomy.message.createMessage.v0", Date.now());

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces?sort=bogus`,
    );
    expect(res.status).toBe(400);
  });

  test("empty DB → empty spaces array, no cursor", async () => {    const ctx = await startAppserver();
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
    // The space needs at least one event to appear in listSpaces.
    seedEvent(ctx, "did:web:s1.example", 0, "space.roomy.message.createMessage.v0", Date.now());

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.listSpaces?cursor=not-a-valid-cursor`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spaces).toHaveLength(1);
  });
});