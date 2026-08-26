/**
 * E2E coverage for the space-restricted endpoint:
 *   space.roomy.space.getUserAccess
 *
 * Reports a user's admin status and role IDs in a space. Authorisation:
 * only the space's own DID may read its user-access state (the arbiter
 * proxies policy-approved requests under the stewarded space's account, so
 * `auth.did === spaceId` is the security boundary).
 *
 * Run: bun test --cwd packages/appserver src/e2e/getUserAccess.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { startAppserver, seedSpace, seedRole, seedMemberRole, spaceDb } from "./helpers.ts";
import { newUlid } from "@roomy-space/sdk";

const ADMIN = "did:plc:e2e-admin";
const USER = "did:plc:e2e-user";
const SPACE = "did:web:space-e2e.example";
const OTHER_SPACE = "did:web:other-e2e.example";

/** Seed an admin edge (head = space, tail = user) in the space's per-space DB. */
function seedAdmin(db: Database, spaceId: string, did: string): void {
  const sp = spaceDb(db, spaceId);
  // The `edges` table has FK constraints on head/tail → entities.id, so the
  // admin's entity row must exist in the space DB before the edge insert.
  sp.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
  sp.run(
    "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
    [spaceId, did],
  );
}

describe("space.roomy.space.getUserAccess", () => {
  test("space's own DID → admin + roleIds", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db, SPACE, USER);

    const roleId = newUlid();
    seedRole(ctx.db, roleId, SPACE, "Moderators");
    seedMemberRole(ctx.db, USER, roleId, SPACE);
    seedAdmin(ctx.db, SPACE, ADMIN);

    // Called as the space itself: isAdmin true for the admin, with roles.
    const adminRes = await ctx.authedFetch(SPACE)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getUserAccess?spaceId=${encodeURIComponent(SPACE)}&userDid=${encodeURIComponent(ADMIN)}`,
    );
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toEqual({ isAdmin: true, roleIds: [] });

    // Non-admin member with a role.
    const memberRes = await ctx.authedFetch(SPACE)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getUserAccess?spaceId=${encodeURIComponent(SPACE)}&userDid=${encodeURIComponent(USER)}`,
    );
    expect(memberRes.status).toBe(200);
    expect(await memberRes.json()).toEqual({ isAdmin: false, roleIds: [roleId] });
  });

  test("fail-closed empty for unknown space", async () => {
    const ctx = await startAppserver();

    // Caller is the (unknown) space itself.
    const res = await ctx.authedFetch(OTHER_SPACE)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getUserAccess?spaceId=${encodeURIComponent(OTHER_SPACE)}&userDid=${encodeURIComponent(USER)}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isAdmin: false, roleIds: [] });
  });

  test("403 when caller is NOT the space's own DID", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db, SPACE, USER);

    // A user calling on the space's behalf.
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getUserAccess?spaceId=${encodeURIComponent(SPACE)}&userDid=${encodeURIComponent(USER)}`,
    );
    expect(res.status).toBe(403);
  });

  test("403 when a different space's DID queries a space it doesn't own", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db, SPACE, USER);

    const res = await ctx.authedFetch(OTHER_SPACE)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getUserAccess?spaceId=${encodeURIComponent(SPACE)}&userDid=${encodeURIComponent(USER)}`,
    );
    expect(res.status).toBe(403);
  });

  test("anonymous → 403", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db, SPACE, USER);

    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getUserAccess?spaceId=${encodeURIComponent(SPACE)}&userDid=${encodeURIComponent(USER)}`,
    );
    expect(res.status).toBe(403);
  });
});
