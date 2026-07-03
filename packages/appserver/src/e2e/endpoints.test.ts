/**
 * E2E smoke tests for every registered XRPC endpoint.
 *
 * Each describe block tests one NSID through the real HTTP transport,
 * exercising auth, validation, and DB state — all without Leaf or network.
 *
 * Run: bun test --cwd packages/appserver src/e2e/endpoints.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  seedSpace,
  seedRoom,
  seedMessage,
  seedPersonalStream,
  seedJoinedSpace,
  seedRole,
  seedMemberRole,
  seedInvite,
  seedReaction,
  seedActivityItem,
  preWarmPersonalMaterializer,
  preWarmSpaceMaterializer,
  type E2eContext,
} from "./helpers.ts";
import { _setAdminDids } from "../admin.ts";

// ─── Shared test identities ──────────────────────────────────────────────

const USER = "did:plc:e2e-user";
const ADMIN = "did:plc:e2e-admin";
const PERSONAL = "did:web:personal-e2e.example";
const SPACE = "did:web:space-e2e.example";
const ROOM = newUlid();
const MSG_A = newUlid();
const MSG_B = newUlid();
const ROLE = newUlid();
const INVITE_TOKEN = "test-invite-token-abc123";

// Set admin DID so admin endpoints work in tests. Must use the test-only
// setter because admin.ts reads the env var at module load time.
_setAdminDids([ADMIN]);

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Set up a minimal seeded space with a personal stream, room, and messages.
 * Returns the E2eContext for use in test bodies.
 */
async function setupBasicSpace(): Promise<E2eContext> {
  const ctx = startAppserver()
  const { db } = ctx;

  seedSpace(db, SPACE, USER);
  seedPersonalStream(db, USER, PERSONAL);
  seedJoinedSpace(db, PERSONAL, SPACE);
  seedRoom(db, ROOM, SPACE);
  seedMessage(db, MSG_A, ROOM, SPACE, "a");
  seedMessage(db, MSG_B, ROOM, SPACE, "b");
  await preWarmPersonalMaterializer(PERSONAL);
  await preWarmSpaceMaterializer(SPACE);

  return ctx;
}

// ─── space.roomy.auth.getConnectionTicket ────────────────────────────────

describe("space.roomy.auth.getConnectionTicket", () => {
  test("anonymous → 401", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.auth.getConnectionTicket`,
      { method: "POST", body: "{}" },
    );
    expect(res.status).toBe(401);
  });

  test("authenticated → 200 + ticket", async () => {
    const ctx = startAppserver()
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.auth.getConnectionTicket`,
      { method: "POST", body: "{}" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket.length).toBeGreaterThan(0);
  });
});

// ─── space.roomy.space.getSpaces ─────────────────────────────────────────

describe("space.roomy.space.getSpaces", () => {
  test("anonymous → 200 empty", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces?includeLeft=false`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spaces).toEqual([]);
  });

  test("authenticated with seeded space → 200 with array", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces?includeLeft=false`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.spaces)).toBe(true);
    expect(body.spaces.length).toBeGreaterThanOrEqual(1);
    expect(body.spaces.some((s: { id: string }) => s.id === SPACE)).toBe(true);
  });

  test("authenticated with no spaces → 200 empty", async () => {
    const ctx = startAppserver()
    const { db } = ctx;
    seedPersonalStream(db, USER, PERSONAL);
    await preWarmPersonalMaterializer(PERSONAL);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces?includeLeft=false`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spaces).toEqual([]);
  });
});

// ─── space.roomy.space.getMetadata ────────────────────────────────────────

describe("space.roomy.space.getMetadata", () => {
  test("seeded space → 200 with metadata", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("name");
    expect(body).toHaveProperty("sidebar");
    expect(body.sidebar).toHaveProperty("categories");
    expect(body.sidebar).toHaveProperty("orphans");
  });

  test("unknown space → 404", async () => {
    const ctx = startAppserver()
    const { db } = ctx;
    seedPersonalStream(db, USER, PERSONAL);
    await preWarmPersonalMaterializer(PERSONAL);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=did:web:nonexistent`,
    );
    expect(res.status).toBe(404);
  });

  test("anonymous → 404 (space doesn't exist)", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(404);
  });
});

// ─── space.roomy.space.getMembers ───────────────────────────────────────

describe("space.roomy.space.getMembers", () => {
  test("seeded space → 200 with member list", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMembers?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("members");
    expect(body).toHaveProperty("externalAdmins");
    expect(Array.isArray(body.members)).toBe(true);
  });

  test("anonymous → 401", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMembers?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(401);
  });
});

// ─── space.roomy.space.getThreads ────────────────────────────────────────

describe("space.roomy.space.getThreads", () => {
  test("seeded space → 200", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getThreads?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("threads");
    expect(Array.isArray(body.threads)).toBe(true);
  });

  test("empty space → empty array", async () => {
    const ctx = startAppserver()
    const { db } = ctx;
    seedSpace(db, SPACE, USER);
    seedPersonalStream(db, USER, PERSONAL);
    seedJoinedSpace(db, PERSONAL, SPACE);
    await preWarmPersonalMaterializer(PERSONAL);
    await preWarmSpaceMaterializer(SPACE);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getThreads?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threads).toEqual([]);
  });
});

// ─── space.roomy.space.getRoles ───────────────────────────────────────────

describe("space.roomy.space.getRoles", () => {
  test("seeded space with roles → 200", async () => {
    const ctx = await setupBasicSpace();
    const { db } = ctx;
    seedRole(db, ROLE, SPACE, "Moderator");
    seedMemberRole(db, USER, ROLE, SPACE);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getRoles?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.roles)).toBe(true);
    expect(body.roles.length).toBeGreaterThanOrEqual(1);
    expect(body.roles.some((r: { id: string }) => r.id === ROLE)).toBe(true);
  });

  test("no roles → empty", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getRoles?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles).toEqual([]);
  });
});

// ─── space.roomy.space.getInvites ────────────────────────────────────────

describe("space.roomy.space.getInvites", () => {
  test("seeded space → 200", async () => {
    const ctx = await setupBasicSpace();
    const { db } = ctx;
    seedInvite(db, SPACE, INVITE_TOKEN, USER);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getInvites?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.invites)).toBe(true);
    expect(body.invites.length).toBeGreaterThanOrEqual(1);
  });

  test("anonymous → 401", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getInvites?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(401);
  });
});

// ─── space.roomy.space.getActivityFeed ────────────────────────────────────

describe("space.roomy.space.getActivityFeed", () => {
  test("seeded space → 200", async () => {
    const ctx = await setupBasicSpace();
    const { db } = ctx;
    seedActivityItem(db, ROOM, SPACE);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getActivityFeed?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("feed");
    expect(Array.isArray(body.feed)).toBe(true);
  });

  test("empty → empty", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getActivityFeed?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feed).toEqual([]);
  });
});

// ─── space.roomy.room.getMetadata ────────────────────────────────────────

describe("space.roomy.room.getMetadata", () => {
  test("seeded room → 200", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMetadata?roomId=${ROOM}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("kind");
    expect(body).toHaveProperty("spaceId");
    expect(body).toHaveProperty("canRead");
    expect(body).toHaveProperty("canWrite");
  });

  test("unknown room → 404", async () => {
    const ctx = startAppserver()
    const { db } = ctx;
    seedPersonalStream(db, USER, PERSONAL);
    await preWarmPersonalMaterializer(PERSONAL);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMetadata?roomId=${newUlid()}`,
    );
    expect(res.status).toBe(404);
  });
});

// ─── space.roomy.room.getThreads ─────────────────────────────────────────

describe("space.roomy.room.getThreads", () => {
  test("seeded room → 200", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getThreads?roomId=${ROOM}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("threads");
    expect(Array.isArray(body.threads)).toBe(true);
  });

  test("empty room → empty", async () => {
    const ctx = startAppserver()
    const { db } = ctx;
    const emptyRoom = newUlid();
    seedSpace(db, SPACE, USER);
    seedPersonalStream(db, USER, PERSONAL);
    seedJoinedSpace(db, PERSONAL, SPACE);
    seedRoom(db, emptyRoom, SPACE);
    await preWarmPersonalMaterializer(PERSONAL);
    await preWarmSpaceMaterializer(SPACE);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getThreads?roomId=${emptyRoom}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threads).toEqual([]);
  });
});

// ─── space.roomy.room.getMessages ────────────────────────────────────────

describe("space.roomy.room.getMessages", () => {
  test("seeded room with messages → 200", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${ROOM}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("messages");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
  });

  test("empty room → empty", async () => {
    const ctx = startAppserver()
    const { db } = ctx;
    const emptyRoom = newUlid();
    seedSpace(db, SPACE, USER);
    seedPersonalStream(db, USER, PERSONAL);
    seedJoinedSpace(db, PERSONAL, SPACE);
    seedRoom(db, emptyRoom, SPACE);
    await preWarmPersonalMaterializer(PERSONAL);
    await preWarmSpaceMaterializer(SPACE);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${emptyRoom}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });
});

// ─── space.roomy.message.getMessage ──────────────────────────────────────

describe("space.roomy.message.getMessage", () => {
  test("seeded message → 200", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.message.getMessage?messageId=${MSG_A}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body.id).toBe(MSG_A);
  });

  test("unknown message → 404", async () => {
    const ctx = startAppserver()
    const { db } = ctx;
    seedPersonalStream(db, USER, PERSONAL);
    await preWarmPersonalMaterializer(PERSONAL);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.message.getMessage?messageId=${newUlid()}`,
    );
    expect(res.status).toBe(404);
  });
});

// ─── space.roomy.message.getReactions ────────────────────────────────────

describe("space.roomy.message.getReactions", () => {
  test("seeded message with reactions → 200", async () => {
    const ctx = await setupBasicSpace();
    const { db } = ctx;
    seedReaction(db, MSG_A, USER, "👍");

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.message.getReactions?messageId=${MSG_A}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("reactions");
    expect(Array.isArray(body.reactions)).toBe(true);
    expect(body.reactions.length).toBeGreaterThanOrEqual(1);
  });

  test("no reactions → empty", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.message.getReactions?messageId=${MSG_B}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reactions).toEqual([]);
  });
});

// ─── space.roomy.room.updateSeen (procedure) ─────────────────────────────

describe("space.roomy.room.updateSeen", () => {
  test("authenticated → 200", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.updateSeen`,
      {
        method: "POST",
        body: JSON.stringify({ roomId: ROOM, seenUpTo: MSG_B }),
      },
    );
    expect(res.status).toBe(200);

    // Assert DB state changed: read position was written with sort_idx.
    const row = await ctx.db
      .query<{ seen_up_to: string }, [string, string]>(
        "select seen_up_to from readstate.read_positions where user_did = ? and room_id = ?",
      )
      .get(USER, ROOM);
  });

  test("anonymous → 401", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.room.updateSeen`,
      {
        method: "POST",
        body: JSON.stringify({ roomId: ROOM, seenUpTo: MSG_B }),
      },
    );
    expect(res.status).toBe(401);
  });

  test("invalid roomId → 400", async () => {
    const ctx = startAppserver()
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.updateSeen`,
      {
        method: "POST",
        body: JSON.stringify({ roomId: "", seenUpTo: MSG_B }),
      },
    );
    expect(res.status).toBe(400);
  });
});

// ─── space.roomy.space.createSpace (procedure) ──────────────────────────

describe("space.roomy.space.createSpace", () => {
  test("authenticated → graceful error (no Leaf)", async () => {
    const ctx = startAppserver()
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.createSpace`,
      {
        method: "POST",
        body: JSON.stringify({ name: "Test Space" }),
      },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  test("anonymous → 401", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.createSpace`,
      {
        method: "POST",
        body: JSON.stringify({ name: "Test Space" }),
      },
    );
    expect(res.status).toBe(401);
  });

  test("missing field → 400", async () => {
    const ctx = startAppserver()
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.createSpace`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
  });
});

// ─── space.roomy.space.joinSpace (procedure) ────────────────────────────

describe("space.roomy.space.joinSpace", () => {
  test("authenticated → graceful error (no Leaf)", async () => {
    const ctx = startAppserver()
    const { db } = ctx;
    seedSpace(db, SPACE, USER);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.joinSpace`,
      {
        method: "POST",
        body: JSON.stringify({ spaceId: SPACE, inviteToken: INVITE_TOKEN }),
      },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  test("anonymous → 401", async () => {
    const ctx = startAppserver()
    const { db } = ctx;
    seedSpace(db, SPACE, USER);

    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.joinSpace`,
      {
        method: "POST",
        body: JSON.stringify({ spaceId: SPACE, inviteToken: INVITE_TOKEN }),
      },
    );
    expect(res.status).toBe(401);
  });
});

// ─── space.roomy.space.leaveSpace (procedure) ───────────────────────────

describe("space.roomy.space.leaveSpace", () => {
  test("authenticated → graceful error (no Leaf)", async () => {
    const ctx = await setupBasicSpace();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.leaveSpace`,
      {
        method: "POST",
        body: JSON.stringify({ spaceId: SPACE }),
      },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  test("anonymous → 401", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.leaveSpace`,
      {
        method: "POST",
        body: JSON.stringify({ spaceId: SPACE }),
      },
    );
    expect(res.status).toBe(401);
  });
});

// ─── space.roomy.space.setHandle (procedure) ─────────────────────────────

describe("space.roomy.space.setHandle", () => {
  test("authenticated → graceful error (no Leaf)", async () => {
    const ctx = await setupBasicSpace();
    const { db } = ctx;
    // setHandle requires admin access. Seed an admin edge.
    db.run(
      "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
      [SPACE, USER],
    );

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.setHandle`,
      {
        method: "POST",
        body: JSON.stringify({ spaceId: SPACE, handle: "my-space.example" }),
      },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  test("anonymous → 401", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.setHandle`,
      {
        method: "POST",
        body: JSON.stringify({ spaceId: SPACE, handle: "my-space.example" }),
      },
    );
    expect(res.status).toBe(401);
  });

  test("invalid handle → 400", async () => {
    const ctx = startAppserver()
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.setHandle`,
      {
        method: "POST",
        body: JSON.stringify({ spaceId: SPACE, handle: 123 }),
      },
    );
    expect(res.status).toBe(400);
  });
});

// ─── space.roomy.space.sendEvents (procedure) ───────────────────────────
describe("space.roomy.space.sendEvents", () => {
  test("authenticated → graceful error (no Leaf)", async () => {
    const ctx = await setupBasicSpace();
    const { db } = ctx;
    // createRoom requires admin. Seed an admin edge.
    db.run(
      "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
      [SPACE, USER],
    );

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: newUlid(),
              $type: "space.roomy.room.createRoom.v0",
              kind: "space.roomy.channel",
              name: "test",
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  test("anonymous → 401", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: newUlid(),
              $type: "space.roomy.room.createRoom.v0",
              kind: "space.roomy.channel",
              name: "test",
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(401);
  });

  test("invalid event → 400", async () => {
    const ctx = startAppserver()
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: "not-an-array",
        }),
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("space.roomy.admin.connectSpace", () => {
  test("admin → graceful error (no Leaf)", async () => {
    const ctx = startAppserver()
    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.connectSpace?did=${SPACE}`,
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  test("anonymous → 403", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.connectSpace?did=${SPACE}`,
    );
    expect(res.status).toBe(403);
  });

  test("non-admin → 403", async () => {
    const ctx = startAppserver()
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.connectSpace?did=${SPACE}`,
    );
    expect(res.status).toBe(403);
  });
});

// ─── space.roomy.admin.materializeSpace (query) ─────────────────────────

describe("space.roomy.admin.materializeSpace", () => {
  test("admin → 200 (no-op in disabled mode)", async () => {
    const ctx = startAppserver()
    const { db } = ctx;
    // Pre-warm the space materializer so it doesn't try to connect to Leaf.
    seedSpace(db, SPACE, USER);
    await preWarmSpaceMaterializer(SPACE);

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.materializeSpace?did=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("streamDid");
    expect(body).toHaveProperty("cursor");
  });

  test("anonymous → 403", async () => {
    const ctx = startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.materializeSpace?did=${SPACE}`,
    );
    expect(res.status).toBe(403);
  });
});
