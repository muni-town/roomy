/**
 * E2E coverage for the per-space DB split:
 *   - membership (joinedSpace/leftSpace) lives ONLY in the global DB
 *   - space data (entities, comp_* tables, member|admin edges) lives in the per-space DB
 *
 * These run through the real HTTP transport (test-mode X-Test-Did auth) with
 * :memory: DBs and disabled backfill, mirroring the boot path.
 *
 * Run: bun test --cwd packages/appserver src/e2e/perSpaceMembership.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  seedSpace,
  seedJoinedSpace,
  seedInvite,
  seedUser,
  seedRoom,
  seedMessage,
  type E2eContext,
} from "./helpers.ts";

// ─── Shared identities ────────────────────────────────────────────────
const USER = "did:plc:e2e-user";
const USER2 = "did:plc:e2e-user-2";
const BANNED = "did:plc:e2e-banned";
const SPACE = "did:web:space-e2e.example";
const SPACE2 = "did:web:space-e2e-b.example";
const INVITE = "test-invite-token-abc123";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

// ─── DB assertion helpers ─────────────────────────────────────────────

/** Membership edge presence in the global DB (joinedSpace/leftSpace). */
async function globalEdge(
  db: AnyDb,
  user: string,
  space: string,
  label: "joinedSpace" | "leftSpace",
): Promise<boolean> {
  const q = "select 1 as n from edges where head = ? and tail = ? and label = ?";
  const row = await db.global().query(q).get(user, space, label);
  return row != null;
}

/** member/admin edge presence in the per-space DB (auth / role state). */
async function spaceEdge(
  db: AnyDb,
  space: string,
  user: string,
  label: "member" | "admin",
): Promise<boolean> {
  const q = "select 1 as n from edges where head = ? and tail = ? and label = ?";
  const row = await db.forSpace(space).query(q).get(space, user, label);
  return row != null;
}

/** Count of rows of a table in the per-space DB. */
async function tableIn(
  db: AnyDb,
  table: "comp_room" | "comp_content",
  space: string,
): Promise<number> {
  const per = await db.forSpace(space).query(`select count(*) as n from ${table}`).get() as { n: number } | undefined;
  return per?.n ?? 0;
}

async function joinSpace(ctx: E2eContext, did: string, space: string, invite?: string) {
  return ctx.authedFetch(did)(`${ctx.baseUrl}/xrpc/space.roomy.space.joinSpace`, {
    method: "POST",
    body: JSON.stringify({ spaceId: space, ...(invite ? { inviteToken: invite } : {}) }),
  });
}

async function leaveSpace(ctx: E2eContext, did: string, space: string) {
  return ctx.authedFetch(did)(`${ctx.baseUrl}/xrpc/space.roomy.space.leaveSpace`, {
    method: "POST",
    body: JSON.stringify({ spaceId: space }),
  });
}

// ─── Membership in the global DB ───────────────────────────────────────

describe("membership tracked in the global DB", () => {
  test("joinSpace (public) writes joinedSpace to the global DB", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });

    const res = await joinSpace(ctx, USER, SPACE);
    expect(res.status).toBe(200);

    expect(await globalEdge(ctx.db as AnyDb, USER, SPACE, "joinedSpace")).toBe(true);
  });

  test("joinSpace (private, invite) writes joinedSpace to the global DB", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 0 });
    seedInvite(ctx.db as AnyDb, SPACE, INVITE, USER);

    const res = await joinSpace(ctx, USER, SPACE, INVITE);
    expect(res.status).toBe(200);

    expect(await globalEdge(ctx.db as AnyDb, USER, SPACE, "joinedSpace")).toBe(true);
  });

  test("leaveSpace removes joinedSpace and writes leftSpace in the global DB", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    await joinSpace(ctx, USER, SPACE);

    const res = await leaveSpace(ctx, USER, SPACE);
    expect(res.status).toBe(200);

    expect(await globalEdge(ctx.db as AnyDb, USER, SPACE, "joinedSpace")).toBe(false);
    expect(await globalEdge(ctx.db as AnyDb, USER, SPACE, "leftSpace")).toBe(true);
  });

  test("rejoin after leave clears leftSpace and restores joinedSpace in the global DB", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    await joinSpace(ctx, USER, SPACE);
    await leaveSpace(ctx, USER, SPACE);

    const res = await joinSpace(ctx, USER, SPACE);
    expect(res.status).toBe(200);

    expect(await globalEdge(ctx.db as AnyDb, USER, SPACE, "joinedSpace")).toBe(true);
    expect(await globalEdge(ctx.db as AnyDb, USER, SPACE, "leftSpace")).toBe(false);
  });

  test("multi-user churn keeps global membership consistent", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedSpace(ctx.db as AnyDb, SPACE2, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, USER2);

    // USER joins SPACE + SPACE2; USER2 joins SPACE only.
    await joinSpace(ctx, USER, SPACE);
    await joinSpace(ctx, USER, SPACE2);
    await joinSpace(ctx, USER2, SPACE);

    // USER leaves SPACE2; USER2 leaves SPACE.
    await leaveSpace(ctx, USER, SPACE2);
    await leaveSpace(ctx, USER2, SPACE);

    // USER still in SPACE; USER2 in nothing; USER left SPACE2.
    expect(await globalEdge(ctx.db as AnyDb, USER, SPACE, "joinedSpace")).toBe(true);
    expect(await globalEdge(ctx.db as AnyDb, USER, SPACE2, "joinedSpace")).toBe(false);
    expect(await globalEdge(ctx.db as AnyDb, USER, SPACE2, "leftSpace")).toBe(true);
    expect(await globalEdge(ctx.db as AnyDb, USER2, SPACE, "joinedSpace")).toBe(false);
    expect(await globalEdge(ctx.db as AnyDb, USER2, SPACE, "leftSpace")).toBe(true);
  });

  test("banned user cannot join → no edge in the global DB", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, BANNED);
    await (ctx.db as AnyDb).forSpace(SPACE).run(
      "insert into comp_bans (entity, user_did) values (?, ?)",
      [SPACE, BANNED],
    );

    const res = await joinSpace(ctx, BANNED, SPACE);
    expect(res.status).toBe(403);

    expect(await globalEdge(ctx.db as AnyDb, BANNED, SPACE, "joinedSpace")).toBe(false);
  });

  test("non-member cannot leave → no leftSpace in the global DB", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, USER2);

    const res = await leaveSpace(ctx, USER2, SPACE);
    expect(res.status).toBe(403);

    expect(await globalEdge(ctx.db as AnyDb, USER2, SPACE, "leftSpace")).toBe(false);
  });

  test("join materialises member edge in the per-space DB (auth/role state)", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, USER2);

    await joinSpace(ctx, USER2, SPACE);
    // member edge is space-scoped (auth), lives in the per-space DB — not global.
    expect(await spaceEdge(ctx.db as AnyDb, SPACE, USER2, "member")).toBe(true);
    expect(await globalEdge(ctx.db as AnyDb, USER2, SPACE, "joinedSpace")).toBe(true);
  });

  test("getSpaces reflects a freshly joined membership (read path)", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, USER2);

    const before = await ctx.authedFetch(USER2)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces?includeLeft=false`,
    );
    expect((await before.json()).spaces).toEqual([]);

    await joinSpace(ctx, USER2, SPACE);

    const after = await ctx.authedFetch(USER2)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces?includeLeft=false`,
    );
    const body = await after.json();
    expect(Array.isArray(body.spaces)).toBe(true);
    expect(body.spaces.some((sp: { id: string }) => sp.id === SPACE)).toBe(true);
  });

  test("createSpace writes joinedSpace to the global DB (when PLC available)", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.createSpace`,
      { method: "POST", body: JSON.stringify({ name: "Test Space" }) },
    );
    if (res.status !== 200) {
      // PLC directory unreachable in CI — the no-backend path is already
      // covered by endpoints.test.ts. Nothing to assert here.
      return;
    }
    const { spaceId } = await res.json();
    expect(await globalEdge(ctx.db as AnyDb, USER, spaceId, "joinedSpace")).toBe(true);
  });
});

// ─── Rooms + messages in the per-space DB ───────────────────────────────

describe("rooms and messages live in the per-space DB", () => {
  async function send(ctx: E2eContext, did: string, space: string, events: unknown[]) {
    return ctx.authedFetch(did)(`${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`, {
      method: "POST",
      body: JSON.stringify({ spaceId: space, events }),
    });
  }

  test("createRoom writes comp_room to the per-space DB", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    await joinSpace(ctx, USER, SPACE);
    // The admin edge must be present in the per-space DB (auth/role state).
    await (ctx.db as AnyDb).forSpace(SPACE).run(
      "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
      [SPACE, USER],
    );

    const room = newUlid();
    const res = await send(ctx, USER, SPACE, [
      { id: room, $type: "space.roomy.room.createRoom.v0", kind: "space.roomy.channel", name: "general" },
    ]);
    expect(res.status).toBe(200);

    expect(await tableIn(ctx.db as AnyDb, "comp_room", SPACE)).toBe(1);

    // The room entity row must exist in the per-space DB too.
    const roomInPer = await (ctx.db as AnyDb)
      .forSpace(SPACE)
      .query("select 1 as n from entities where id = ?")
      .get(room);
    expect(roomInPer).not.toBeNull();
  });

  test("createMessage writes comp_content + author edge to the per-space DB", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    await joinSpace(ctx, USER, SPACE);

    // Need a room to target, present in the per-space DB.
    const room = newUlid();
    await (ctx.db as AnyDb).forSpace(SPACE).run(
      "insert or ignore into entities (id, stream_id) values (?, ?)",
      [room, SPACE],
    );
    await (ctx.db as AnyDb).forSpace(SPACE).run(
      "insert or ignore into comp_room (entity, label) values (?, 'space.roomy.channel')",
      [room],
    );

    const msgId = newUlid();
    const res = await send(ctx, USER, SPACE, [
      {
        id: msgId,
        $type: "space.roomy.message.createMessage.v0",
        room,
        body: {
          mimeType: "text/plain",
          data: { $bytes: Buffer.from("hello").toString("base64") },
        },
        extensions: {},
      },
    ]);
    expect(res.status).toBe(200);

    // comp_content may also hold a system "joined" message, so assert the
    // specific message row exists rather than a total count.
    const msgPer = await (ctx.db as AnyDb)
      .forSpace(SPACE)
      .query("select 1 as n from comp_content where entity = ?")
      .get(msgId);
    expect(msgPer).not.toBeNull();

    expect(await spaceEdge(ctx.db as AnyDb, SPACE, USER, "member")).toBe(true);
  });

  test("membership edges are routed to global, not the per-space DB", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    await joinSpace(ctx, USER, SPACE);

    // The joinedSpace edge must NOT appear in the per-space DB.
    const per = await (ctx.db as AnyDb)
      .forSpace(SPACE)
      .query("select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'")
      .get(USER, SPACE);
    expect(per).toBeNull();

    // But it is in the global DB.
    expect(await globalEdge(ctx.db as AnyDb, USER, SPACE, "joinedSpace")).toBe(true);
  });
});

// ─── Cross-stream profiles resolve from the global store ───────────────

describe("cross-stream profiles resolve from the global store", () => {
  test("getMessages resolves a cross-stream author from the global profiles table", async () => {
    const ctx = await startAppserver();
    const { db } = ctx;
    const room = newUlid();
    const msg = newUlid();

    seedSpace(db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedJoinedSpace(db as AnyDb, USER, SPACE);
    seedRoom(db as AnyDb, room, SPACE);
    seedMessage(db as AnyDb, msg, room, SPACE, "a");

    // Author edge: msg → USER2, in the per-space DB. USER2's profile entity
    // lives in USER2's OWN stream (not SPACE's), so the per-space DB does NOT
    // carry USER2's comp_user/comp_info — the author resolves to blank from
    // the per-space join. The authoritative profile lives in the global store.
    await (db as AnyDb).forSpace(SPACE).run(
      "insert or ignore into entities (id, stream_id) values (?, ?)",
      [USER2, USER2],
    );
    await (db as AnyDb).forSpace(SPACE).run(
      "insert or ignore into edges (head, tail, label) values (?, ?, 'author')",
      [msg, USER2],
    );
    // Seed the global profiles table (the authoritative store).
    await (db as AnyDb).global().run(
      "insert into profiles (did, handle, name, avatar) values (?, ?, ?, ?)",
      [USER2, "user2.test", "User Two", "https://cdn.example/user2.png"],
    );

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${room}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const authorMsg = body.messages.find((m: { id: string }) => m.id === msg);
    expect(authorMsg).toBeDefined();
    expect(authorMsg.authorDid).toBe(USER2);
    expect(authorMsg.authorName).toBe("User Two");
    expect(authorMsg.authorHandle).toBe("user2.test");
    expect(authorMsg.authorAvatar).toBe("https://cdn.example/user2.png");
  });
});

// ─── Concurrency ───────────────────────────────────────────────────────

describe("concurrency", () => {
  test("concurrent joins keep global membership consistent", async () => {
    const ctx = await startAppserver();
    seedSpace(ctx.db as AnyDb, SPACE, USER, { allowPublicJoin: 1 });
    seedUser(ctx.db as AnyDb, USER2);

    await Promise.all([joinSpace(ctx, USER, SPACE), joinSpace(ctx, USER2, SPACE)]);

    expect(await globalEdge(ctx.db as AnyDb, USER, SPACE, "joinedSpace")).toBe(true);
    expect(await globalEdge(ctx.db as AnyDb, USER2, SPACE, "joinedSpace")).toBe(true);
  });
});
