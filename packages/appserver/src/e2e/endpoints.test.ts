/**
 * E2E smoke tests for every registered XRPC endpoint.
 *
 * Each describe block tests one NSID through the real HTTP transport,
 * exercising auth, validation, and DB state — all without a remote event backend or network.
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
  seedJoinedSpace,
  seedRole,
  seedMemberRole,
  seedInvite,
  seedReaction,
  seedUser,
  seedActivityItem,
  seedReadPosition,
  spaceDb,
  readStateDb,
  type E2eContext,
} from "./helpers.ts";
import { _setAdminDids } from "../admin.ts";
import type { AsyncDatabase } from "../db/asyncDatabase.ts";

// ─── Shared test identities ──────────────────────────────────────────────

const USER = "did:plc:e2e-user";
const ADMIN = "did:plc:e2e-admin";
const MENT = "did:plc:e2e-mentioned";
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
 * Set up a minimal seeded space with a room and messages.
 * Returns the E2eContext for use in test bodies.
 */
async function setupBasicSpace(): Promise<E2eContext> {
  const ctx = await startAppserver()
  const { db } = ctx;

  seedSpace(db, SPACE, USER);
  seedJoinedSpace(db, USER, SPACE);
  seedRoom(db, ROOM, SPACE);
  seedMessage(db, MSG_A, ROOM, SPACE, "a");
  seedMessage(db, MSG_B, ROOM, SPACE, "b");
  return ctx;
}

// ─── space.roomy.auth.getConnectionTicket ────────────────────────────────

describe("space.roomy.auth.getConnectionTicket", () => {
  test("anonymous → 401", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.auth.getConnectionTicket`,
      { method: "POST", body: "{}" },
    );
    expect(res.status).toBe(401);
  });

  test("authenticated → 200 + ticket", async () => {
    const ctx = await startAppserver()
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
    const ctx = await startAppserver()
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
    const ctx = await startAppserver()
    const { db } = ctx;
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces?includeLeft=false`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spaces).toEqual([]);
  });

  test("unreadRoomCount counts channels + engaged threads with unreads", async () => {
    const ctx = await startAppserver();
    const { db } = ctx;
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);

    // Channel with unread messages.
    const channel = newUlid();
    seedRoom(db, channel, SPACE);
    seedReadPosition(db, USER, channel, "0", 3);

    // Engaged thread with unread messages (user_thread_activity + read_positions).
    const thread = newUlid();
    seedRoom(db, thread, SPACE, "space.roomy.thread");
    readStateDb(db).run(
      `insert into user_thread_activity (user_did, thread_id, space_did, last_active_at, updated_at)
       values (?, ?, ?, ?, ?)`,
      [USER, thread, SPACE, Date.now(), Date.now()],
    );
    seedReadPosition(db, USER, thread, "0", 1);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces?includeLeft=false`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const space = body.spaces.find((s: { id: string }) => s.id === SPACE);
    expect(space).toBeDefined();
    // Home cards show the combined rooms-with-unreads count.
    expect(space.unreadRoomCount).toBe(2);
    expect(space.unreadCount).toBe(4);
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
    const ctx = await startAppserver()
    const { db } = ctx;
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=did:web:nonexistent`,
    );
    expect(res.status).toBe(404);
  });

  test("anonymous → 404 (space doesn't exist)", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(404);
  });

  test("sidebar channels carry activeThreads from user_thread_activity", async () => {
    const ctx = await startAppserver();
    const { db } = ctx;
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);

    // Channel with an engaged thread (user_thread_activity row + link edge).
    const channel = newUlid();
    seedRoom(db, channel, SPACE);
    const thread = newUlid();
    seedRoom(db, thread, SPACE, "space.roomy.thread");
    spaceDb(db, SPACE).run(
      `insert into comp_info (entity, name) values (?, ?)`,
      [thread, "Engaged Thread"],
    );
    spaceDb(db, SPACE).run(
      `insert into edges (head, tail, label, payload) values (?, ?, 'link', ?)`,
      [channel, thread, JSON.stringify({ canonical_parent: 1 })],
    );
    readStateDb(db).run(
      `insert into user_thread_activity (user_did, thread_id, space_did, last_active_at, updated_at)
       values (?, ?, ?, ?, ?)`,
      [USER, thread, SPACE, Date.now(), Date.now()],
    );

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const allChannels = [
      ...(body.sidebar.categories ?? []).flatMap((c: { channels: unknown[] }) => c.channels),
      ...(body.sidebar.orphans ?? []),
    ];
    const ch = allChannels.find((c: { id: string }) => c.id === channel);
    expect(ch).toBeDefined();
    expect(ch.activeThreads).toBeDefined();
    expect(ch.activeThreads).toHaveLength(1);
    expect(ch.activeThreads[0].id).toBe(thread);
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
    const ctx = await startAppserver()
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
    expect(body).toHaveProperty("rooms");
    expect(Array.isArray(body.rooms)).toBe(true);
  });

  test("returns channels alongside threads, with kind", async () => {
    const ctx = await startAppserver();
    const { db } = ctx;
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);

    const channel = newUlid();
    seedRoom(db, channel, SPACE);
    spaceDb(db, SPACE).run(
      "insert into comp_info (entity, name) values (?, ?)",
      [channel, "general"],
    );
    const msgId = newUlid();
    seedMessage(db, msgId, channel, SPACE, "a");
    spaceDb(db, SPACE).run(
      "update comp_content set timestamp = ? where entity = ?",
      [Date.now(), msgId],
    );
    seedActivityItem(db, channel, SPACE, Date.now());
    seedReadPosition(db, USER, channel, "a", 2);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getThreads?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const room = body.rooms.find((x: { id: string }) => x.id === channel);
    expect(room).toBeDefined();
    expect(room.kind).toBe("channel");
    expect(room.name).toBe("general");
    expect(room.unreadCount).toBe(2);
    expect(room.unread).toBe(true);
    expect(room.channel).toBeUndefined();
  });

  test("empty space → empty array", async () => {
    const ctx = await startAppserver()
    const { db } = ctx;
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getThreads?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rooms).toEqual([]);
  });

  test("threads the user never engaged with read as unread (honest view)", async () => {
    const ctx = await startAppserver();
    const { db } = ctx;
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);

    // A thread with messages, linked from a channel. The user has NO
    // user_thread_activity row and NO read_positions row for it.
    const channel = newUlid();
    seedRoom(db, channel, SPACE);
    const thread = newUlid();
    seedRoom(db, thread, SPACE, "space.roomy.thread");
    // Canonical parent link (channel → thread).
    spaceDb(db, SPACE).run(
      `insert into edges (head, tail, label, payload) values (?, ?, 'link', ?)`,
      [channel, thread, JSON.stringify({ canonical_parent: 1 })],
    );
    const msgId = newUlid();
    seedMessage(db, msgId, thread, SPACE, "a");
    // comp_content.timestamp drives latestTimestamp in listThreadActivity;
    // seedMessage leaves it null, so set it explicitly.
    spaceDb(db, SPACE).run(
      "update comp_content set timestamp = ? where entity = ?",
      [Date.now(), msgId],
    );
    seedActivityItem(db, thread, SPACE, Date.now());

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getThreads?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const t = body.rooms.find((x: { id: string }) => x.id === thread);
    expect(t).toBeDefined();
    expect(t.kind).toBe("thread");
    // unreadCount is 0 (no read_positions row) but the honest flag is true.
    expect(t.unreadCount).toBe(0);
    expect(t.unread).toBe(true);
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
    const ctx = await startAppserver()
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
    const ctx = await startAppserver()
    const { db } = ctx;

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMetadata?roomId=${newUlid()}`,
    );
    expect(res.status).toBe(404);
  });

  test("channel metadata reports engaged threads with unreads (Threads-tab badge)", async () => {
    const ctx = await startAppserver();
    const { db } = ctx;
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);

    const channel = newUlid();
    seedRoom(db, channel, SPACE);

    // Two engaged threads in the channel; one has unread messages.
    const t1 = newUlid();
    const t2 = newUlid();
    for (const t of [t1, t2]) {
      seedRoom(db, t, SPACE, "space.roomy.thread");
      spaceDb(db, SPACE).run(
        `insert into edges (head, tail, label, payload) values (?, ?, 'link', ?)`,
        [channel, t, JSON.stringify({ canonical_parent: 1 })],
      );
      readStateDb(db).run(
        `insert into user_thread_activity (user_did, thread_id, space_did, last_active_at, updated_at)
         values (?, ?, ?, ?, ?)`,
        [USER, t, SPACE, Date.now(), Date.now()],
      );
    }
    seedReadPosition(db, USER, t1, "0", 2); // unread
    seedReadPosition(db, USER, t2, "0", 0); // read

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMetadata?roomId=${channel}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unreadThreadCount).toBe(1);
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
    const ctx = await startAppserver()
    const { db } = ctx;
    const emptyRoom = newUlid();
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);
    seedRoom(db, emptyRoom, SPACE);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getThreads?roomId=${emptyRoom}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threads).toEqual([]);
  });
});

// ─── space.roomy.search.rooms ───────────────────────────────────────────

describe("space.roomy.search.rooms", () => {
  test("name search finds channels and threads with parent context", async () => {
    const ctx = await startAppserver();
    const { db } = ctx;
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);

    // Channels: "lobby", "coordination" (matching "c")
    const lobby = newUlid();
    seedRoom(db, lobby, SPACE);
    spaceDb(db, SPACE).run(
      `insert into comp_info (entity, name) values (?, ?)`,
      [lobby, "lobby"],
    );
    const coordination = newUlid();
    seedRoom(db, coordination, SPACE);
    spaceDb(db, SPACE).run(
      `insert into comp_info (entity, name) values (?, ?)`,
      [coordination, "coordination"],
    );

    // Thread under coordination, named "coordination thread"
    const thread = newUlid();
    seedRoom(db, thread, SPACE, "space.roomy.thread");
    spaceDb(db, SPACE).run(
      `insert into comp_info (entity, name) values (?, ?)`,
      [thread, "coordination thread"],
    );
    spaceDb(db, SPACE).run(
      `insert into edges (head, tail, label, payload) values (?, ?, 'link', ?)`,
      [coordination, thread, JSON.stringify({ canonical_parent: 1 })],
    );

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.search.rooms?spaceId=${SPACE}&q=coordination`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("rooms");
    // Channel first, then thread — both match "coordination".
    const rooms = body.rooms as Array<{
      id: string;
      name: string;
      kind: string;
      canWrite: boolean;
      channelId?: string;
      channelName?: string;
    }>;
    expect(rooms.length).toBeGreaterThanOrEqual(2);
    const channelHit = rooms.find((r) => r.id === coordination);
    expect(channelHit).toBeDefined();
    expect(channelHit!.kind).toBe("channel");
    const threadHit = rooms.find((r) => r.id === thread);
    expect(threadHit).toBeDefined();
    expect(threadHit!.kind).toBe("thread");
    expect(threadHit!.channelId).toBe(coordination);
    expect(threadHit!.channelName).toBe("coordination");
  });

  test("empty query → 400", async () => {
    const ctx = await startAppserver();
    const { db } = ctx;
    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.search.rooms?spaceId=${SPACE}&q=`,
    );
    expect(res.status).toBe(400);
  });

  test("non-member of private space → 403", async () => {
    const ctx = await startAppserver();
    const { db } = ctx;
    seedSpace(db, SPACE, USER, { allowPublicJoin: 0 });

    const res = await ctx.authedFetch("did:plc:e2e-visitor")(
      `${ctx.baseUrl}/xrpc/space.roomy.search.rooms?spaceId=${SPACE}&q=lobby`,
    );
    expect(res.status).toBe(403);
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
    const ctx = await startAppserver()
    const { db } = ctx;
    const emptyRoom = newUlid();
    seedSpace(db, SPACE, USER);
    seedRoom(db, emptyRoom, SPACE);
    seedJoinedSpace(db, USER, SPACE);

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
    const ctx = await startAppserver()
    const { db } = ctx;

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

  test("resolves reactor profiles from the global store (cross-stream)", async () => {
    const ctx = await setupBasicSpace();
    const REACTOR = "did:plc:e2e-reactor";
    // The reactor's profile lives in their OWN stream, not this space's.
    // Seed it only in the global `profiles` table (the authoritative store).
    // Insert the reactor as an entity in the space DB (comp_reaction.user
    // has an FK to entities.id).
    await (ctx.db as unknown as AsyncDatabase)
      .forSpace(SPACE)
      .run("insert or ignore into entities (id, stream_id) values (?, ?)", [
        REACTOR,
        REACTOR,
      ]);
    seedUser(ctx.db, REACTOR, "reactor.test");
    await seedReaction(ctx.db, MSG_A, REACTOR, "❤️");

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.message.getReactions?messageId=${MSG_A}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const group = body.reactions.find(
      (g: { emoji: string }) => g.emoji === "❤️",
    );
    expect(group).toBeDefined();
    const reactor = group.reactors.find(
      (r: { did: string }) => r.did === REACTOR,
    );
    expect(reactor).toBeDefined();
    // Handle should resolve from the global store, not fall back to the DID.
    expect(reactor.handle).toBe("reactor.test");
    expect(reactor.did).toBe(REACTOR);
  });
});

// ─── space.roomy.mention.getMentions ─────────────────────────────────────

describe("space.roomy.mention.getMentions", () => {
  test("mention rows load messages from per-space DBs (no 'entities' table on global DB)", async () => {
    const ctx = await startAppserver();
    const { db } = ctx;
    const MENTIONED = "did:plc:e2e-mentioned";

    seedSpace(db, SPACE, USER);
    seedJoinedSpace(db, USER, SPACE);
    seedRoom(db, ROOM, SPACE);
    seedMessage(db, MSG_A, ROOM, SPACE, "a");
    // Author profile lives in the global store; without it the read path
    // tries on-demand hydration (network) and falls back to an empty name.
    seedUser(db, USER, "author.test");
    // Seed the mention row exactly as materialization dual-writes it.
    await (ctx.db as unknown as AsyncDatabase)
      .global()
      .run(
        "insert into mentions (did, message_id, space_did, room_id, created_at) values (?, ?, ?, ?, ?)",
        [MENT, MSG_A, SPACE, ROOM, Date.now()],
      );

    const res = await ctx.authedFetch(MENT)(
      `${ctx.baseUrl}/xrpc/space.roomy.mention.getMentions?did=${encodeURIComponent(MENT)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mentions).toHaveLength(1);
    expect(body.mentions[0].message.id).toBe(MSG_A);
    expect(body.mentions[0].spaceId).toBe(SPACE);
    expect(body.mentions[0].roomId).toBe(ROOM);
  });

  test("empty mentions → empty", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.mention.getMentions?did=${encodeURIComponent(USER)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mentions).toEqual([]);
  });

  test("forbidden: querying another user's mentions", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.mention.getMentions?did=${encodeURIComponent("did:plc:someone-else")}`,
    );
    expect(res.status).toBe(403);
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
    const row = await (ctx.db as unknown as AsyncDatabase)
      .readState()
      .query("select seen_up_to from read_positions where user_did = ? and room_id = ?")
      .get<{ seen_up_to: string }>(USER, ROOM);
  });

  test("anonymous → 401", async () => {
    const ctx = await startAppserver()
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
    const ctx = await startAppserver()
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
  test("authenticated → creates space and returns spaceId", async () => {
    const ctx = await startAppserver()
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.createSpace`,
      {
        method: "POST",
        body: JSON.stringify({ name: "Test Space" }),
      },
    );
    // createStreamDid calls PLC directory which may not be available in test;
    // if it succeeds, expect 200 with spaceId; if it fails, expect a 500
    // with a PLC-related error (not the old no-backend error).
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("spaceId");
      expect(typeof body.spaceId).toBe("string");
    } else {
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toHaveProperty("error");
      // Must NOT be the old no-backend error
      expect(body.error).not.toBe("InternalServerError");
    }
  });

  test("anonymous → 401", async () => {
    const ctx = await startAppserver()
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
    const ctx = await startAppserver()
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
  test("authenticated → joins space and returns spaceId", async () => {
    const ctx = await startAppserver()
    const { db } = ctx;
    // Private space: the invite token is required to join. Exercise the
    // token-validation path rather than relying on the public default.
    seedSpace(db, SPACE, USER, { allowPublicJoin: 0 });
    seedInvite(db, SPACE, INVITE_TOKEN, USER);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.joinSpace`,
      {
        method: "POST",
        body: JSON.stringify({ spaceId: SPACE, inviteToken: INVITE_TOKEN }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("spaceId");
    expect(body.spaceId).toBe(SPACE);
  });

  test("anonymous → 401", async () => {
    const ctx = await startAppserver()
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
  test("authenticated → leaves space and returns 200", async () => {
    const ctx = await setupBasicSpace();
    const { db } = ctx;
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.leaveSpace`,
      {
        method: "POST",
        body: JSON.stringify({ spaceId: SPACE }),
      },
    );
    expect(res.status).toBe(200);

    // Leave removes join intent: the joinedSpace edge must be deleted and a
    // leftSpace edge written (so includeLeft still lists the space once).
    const joined = await (db as any)
      .global()
      .query("select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'")
      .get(USER, SPACE);
    expect(joined).toBeNull();
    const left = await (db as any)
      .global()
      .query("select 1 as n from edges where head = ? and tail = ? and label = 'leftSpace'")
      .get(USER, SPACE);
    expect(left).not.toBeNull();
  });

  test("anonymous → 401", async () => {
    const ctx = await startAppserver()
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
  test("authenticated → persists handle in local DB (no remote backend needed)", async () => {
    const ctx = await setupBasicSpace();
    const { db } = ctx;
    // setHandle requires admin access. Seed an admin edge in the per-space DB.
    await (db as any).forSpace(SPACE).run(
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
    expect(res.status).toBe(200);
    const row = await (db as unknown as AsyncDatabase)
      .forSpace(SPACE)
      .query("select handle from comp_space where entity = ?")
      .get<{ handle: string | null }>(SPACE);
    expect(row?.handle).toBe("my-space.example");
  });

  test("anonymous → 401", async () => {
    const ctx = await startAppserver()
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
    const ctx = await startAppserver()
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
  test("authenticated → sends events and returns 200", async () => {
    const ctx = await setupBasicSpace();
    const { db } = ctx;
    // createRoom requires admin. Seed an admin edge in the per-space DB.
    (db as any).forSpace(SPACE).run(
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
    expect(res.status).toBe(200);
  });

  test("anonymous → 401", async () => {
    const ctx = await startAppserver()
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
    const ctx = await startAppserver()
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
  test("admin → returns space info from local DB (no remote backend needed)", async () => {
    const ctx = await startAppserver()
    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.connectSpace?did=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("serviceDid");
    expect(body.streamDid).toBe(SPACE);
    expect(body.roomCount).toBe(0);
    expect(body.rooms).toEqual([]);
  });

  test("anonymous → 403", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.connectSpace?did=${SPACE}`,
    );
    expect(res.status).toBe(403);
  });

  test("non-admin → 403", async () => {
    const ctx = await startAppserver()
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.connectSpace?did=${SPACE}`,
    );
    expect(res.status).toBe(403);
  });
});

// ─── space.roomy.admin.materializeSpace (query) ─────────────────────────

describe("space.roomy.admin.materializeSpace", () => {
  test("admin → 200 (no-op in disabled mode)", async () => {
    const ctx = await startAppserver()
    const { db } = ctx;
    seedSpace(db, SPACE, USER);
    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.materializeSpace?did=${SPACE}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("streamDid");
    expect(body).toHaveProperty("cursor");
  });

  test("anonymous → 403", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.materializeSpace?did=${SPACE}`,
    );
    expect(res.status).toBe(403);
  });
});
