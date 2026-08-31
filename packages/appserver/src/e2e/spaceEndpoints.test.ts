/**
 * Space-scoped endpoint coverage, exercised through the REAL materialization
 * path (materializeSpace drives sendEvents → applyBatch → per-space DB +
 * global entity_space index). This catches regressions like space reads
 * breaking after the per-space split.
 *
 * Run: bun test --cwd packages/appserver src/e2e/spaceEndpoints.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  materializeSpace,
  seedInvite,
  seedJoinedSpace,
  seedUser,
  type E2eContext,
} from "./helpers.ts";

const USER = "did:plc:e2e-user";
const SPACE = "did:web:space-e2e.example";

async function get(ctx: E2eContext, path: string) {
  return ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/${path}`);
}

describe("space.roomy.space.getSpaces (materialized)", () => {
  test("returns the materialized space after join", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.space.getSpaces?includeLeft=false`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.spaces)).toBe(true);
    expect(body.spaces.some((s: { id: string }) => s.id === SPACE)).toBe(true);
  });
});

describe("space.roomy.space.getMetadata (materialized)", () => {
  test("returns metadata + sidebar for a materialized space", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.space.getMetadata?spaceId=${SPACE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("name");
    expect(body).toHaveProperty("sidebar");
    expect(Array.isArray(body.sidebar.orphans)).toBe(true);
  });

  test("unknown space → 404", async () => {
    const ctx = await startAppserver();
    const res = await get(ctx, `space.roomy.space.getMetadata?spaceId=did:web:nope`);
    expect(res.status).toBe(404);
  });
});

describe("space.roomy.space.getThreads (materialized)", () => {
  test("returns 200 with rooms array", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.space.getThreads?spaceId=${SPACE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rooms)).toBe(true);
  });
});

describe("space.roomy.space.getActivityFeed (materialized)", () => {
  test("returns the materialized message's room in the feed", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.space.getActivityFeed?spaceId=${SPACE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.feed)).toBe(true);
    expect(body.feed.length).toBeGreaterThanOrEqual(1);
  });
});

describe("space.roomy.space.getMembers (materialized)", () => {
  test("returns the member who materialized the space", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.space.getMembers?spaceId=${SPACE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.members)).toBe(true);
    expect(body.members.some((m: { did: string }) => m.did === USER)).toBe(true);
  });
});

describe("space.roomy.space.getRoles (materialized)", () => {
  test("returns 200 with roles array (empty by default)", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.space.getRoles?spaceId=${SPACE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.roles)).toBe(true);
  });
});

describe("space.roomy.space.getInvites (materialized)", () => {
  test("returns a seeded invite", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER);
    seedInvite(ctx.db as unknown as import("bun:sqlite").Database, SPACE, "tok-123", USER);

    const res = await get(ctx, `space.roomy.space.getInvites?spaceId=${SPACE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.invites)).toBe(true);
    expect(body.invites.length).toBeGreaterThanOrEqual(1);
  });
});

describe("space.roomy.space.setHandle (materialized)", () => {
  test("admin can set the space handle", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.setHandle`,
      { method: "POST", body: JSON.stringify({ spaceId: SPACE, handle: "my-space.example" }) },
    );
    expect(res.status).toBe(200);
  });
});

describe("space.roomy.space.joinSpace / leaveSpace (materialized)", () => {
  test("a second user can join and leave the materialized space", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER);
    const USER2 = "did:plc:e2e-user-2";
    seedUser(ctx.db as unknown as import("bun:sqlite").Database, USER2);

    const join = await ctx.authedFetch(USER2)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.joinSpace`,
      { method: "POST", body: JSON.stringify({ spaceId: SPACE }) },
    );
    expect(join.status).toBe(200);

    // Joined user can now read the room.
    const msgs = await ctx.authedFetch(USER2)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${roomId}`,
    );
    expect(msgs.status).toBe(200);

    const leave = await ctx.authedFetch(USER2)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.leaveSpace`,
      { method: "POST", body: JSON.stringify({ spaceId: SPACE }) },
    );
    expect(leave.status).toBe(200);
  });
});
