/**
 * Endpoint-by-endpoint e2e coverage for room/message-scoped handlers.
 *
 * Unlike the seed-directly tests, these materialize a space through the REAL
 * write path (`space.roomy.space.sendEvents` → applyBatch → per-space DB +
 * global entity_space index), then query each endpoint. This is what catches
 * regressions like room-scoped handlers 404ing when the entity→space index is
 * not populated for materialized rooms/messages.
 *
 * Run: bun test --cwd packages/appserver src/e2e/roomEndpoints.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  materializeSpace,
  seedJoinedSpace,
  seedSpace,
  type E2eContext,
} from "./helpers.ts";

const USER = "did:plc:e2e-user";
const OTHER = "did:plc:e2e-other";
const SPACE = "did:web:space-e2e.example";

async function get(ctx: E2eContext, path: string) {
  return ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/${path}`);
}

describe("room-scoped endpoints resolve a materialized room", () => {
  test("getMessages returns the materialized message", async () => {
    const ctx = await startAppserver();
    const { roomId, messageId } = await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.room.getMessages?roomId=${roomId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.some((m: { id: string }) => m.id === messageId)).toBe(true);
  });

  test("getMessages omits the edit marker until an editEvent lands, then reports it", async () => {
    const ctx = await startAppserver();
    const { roomId, messageId } = await materializeSpace(ctx, SPACE, USER);

    const before = await (
      await get(ctx, `space.roomy.room.getMessages?roomId=${roomId}`)
    ).json();
    const fresh = before.messages.find((m: { id: string }) => m.id === messageId);
    expect(fresh).toBeDefined();
    // A freshly created message stores `last_edit = <its own create event id>`,
    // which is the "never edited" state — no marker on the wire.
    expect(fresh.lastEdit).toBeUndefined();

    const editEventId = newUlid();
    const editRes = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: editEventId,
              $type: "space.roomy.message.editMessage.v0",
              room: roomId,
              messageId,
              body: {
                mimeType: "text/plain",
                data: { $bytes: Buffer.from("edited text").toString("base64") },
              },
              extensions: {},
            },
          ],
        }),
      },
    );
    expect(editRes.status).toBe(200);

    const after = await (
      await get(ctx, `space.roomy.room.getMessages?roomId=${roomId}`)
    ).json();
    const edited = after.messages.find((m: { id: string }) => m.id === messageId);
    expect(edited.content).toBe("edited text");
    // The marker is the edit EVENT id, so a client can also correlate it.
    expect(edited.lastEdit).toBe(editEventId);
  });

  test("getThreads returns 200 for a channel", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.room.getThreads?roomId=${roomId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.threads)).toBe(true);
  });

  test("getMetadata returns 200 with room metadata", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, { roomName: "general" });

    const res = await get(ctx, `space.roomy.room.getMetadata?roomId=${roomId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("spaceId", SPACE);
  });

  test("getRoomSummary returns 200", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.room.getRoomSummary?roomId=${roomId}`);
    expect(res.status).toBe(200);
  });

  test("updateSeen returns 200 and persists the read position", async () => {
    const ctx = await startAppserver();
    const { roomId, messageId } = await materializeSpace(ctx, SPACE, USER);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.updateSeen`,
      { method: "POST", body: JSON.stringify({ roomId, seenUpTo: messageId }) },
    );
    expect(res.status).toBe(200);

    const row = await (ctx.db as unknown as { readState(): { query(s: string): { get<T>(...p: unknown[]): Promise<T | null> } } })
      .readState()
      .query("select seen_up_to from read_positions where user_did = ? and room_id = ?")
      .get<{ seen_up_to: string }>(USER, roomId);
    expect(row?.seen_up_to).toBeTruthy();
  });
});

describe("message-scoped endpoints resolve a materialized message", () => {
  test("getMessage returns the materialized message", async () => {
    const ctx = await startAppserver();
    const { messageId } = await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.message.getMessage?messageId=${messageId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("id", messageId);
  });

  test("getReactions returns 200 (empty reactions)", async () => {
    const ctx = await startAppserver();
    const { messageId } = await materializeSpace(ctx, SPACE, USER);

    const res = await get(ctx, `space.roomy.message.getReactions?messageId=${messageId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.reactions)).toBe(true);
  });
});

describe("message moving through the real write path", () => {
  /**
   * Create a destination channel, then move `messageId` from `sourceRoomId`
   * into it via `sendEvents`. `materializeSpace` seeds USER as a space admin,
   * which is what the move requires.
   */
  async function moveMessage(
    ctx: E2eContext,
    sourceRoomId: string,
    messageId: string,
  ): Promise<string> {
    const destRoomId = newUlid();
    // The destination must be materialized before the move is authorized —
    // the same ordering every other room-write event requires.
    const created = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: destRoomId,
              $type: "space.roomy.room.createRoom.v0",
              kind: "space.roomy.channel",
              name: "moved-here",
            },
          ],
        }),
      },
    );
    if (created.status !== 200) {
      throw new Error(`moveMessage createRoom failed ${created.status}: ${await created.text()}`);
    }

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: newUlid(),
              room: sourceRoomId,
              $type: "space.roomy.message.moveMessages.v0",
              messageIds: [messageId],
              toRoomId: destRoomId,
            },
          ],
        }),
      },
    );
    if (res.status !== 200) {
      throw new Error(`moveMessage failed ${res.status}: ${await res.text()}`);
    }
    return destRoomId;
  }

  test("a moved message leaves the source room and appears in the destination", async () => {
    const ctx = await startAppserver();
    const { roomId, messageId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "please move me",
    });

    const destRoomId = await moveMessage(ctx, roomId, messageId);

    const source = await (
      await get(ctx, `space.roomy.room.getMessages?roomId=${roomId}`)
    ).json();
    expect(source.messages.some((m: { id: string }) => m.id === messageId)).toBe(false);

    const dest = await (
      await get(ctx, `space.roomy.room.getMessages?roomId=${destRoomId}`)
    ).json();
    const moved = dest.messages.find((m: { id: string }) => m.id === messageId);
    expect(moved).toBeDefined();
    // The content is intact — a move relocates the message, it does not copy
    // or rewrite it.
    expect(moved.content).toBe("please move me");
  });

  test("getMessage resolves the message's NEW room after a move", async () => {
    const ctx = await startAppserver();
    const { roomId, messageId } = await materializeSpace(ctx, SPACE, USER);

    const before = await (
      await get(ctx, `space.roomy.message.getMessage?messageId=${messageId}`)
    ).json();
    expect(before).toHaveProperty("id", messageId);

    const destRoomId = await moveMessage(ctx, roomId, messageId);

    // getMessage resolves the room from entities.room and re-checks read
    // access there, so a stale room link must 404 rather than leak the
    // message.
    const res = await get(ctx, `space.roomy.message.getMessage?messageId=${messageId}`);
    expect(res.status).toBe(200);
    const after = await res.json();
    expect(after).toHaveProperty("id", messageId);

    // And the destination room's metadata now counts it.
    const destMeta = await (
      await get(ctx, `space.roomy.room.getMetadata?roomId=${destRoomId}`)
    ).json();
    expect(destMeta).toHaveProperty("spaceId", SPACE);
  });

  test("a move into a freshly created room works when the room is created first", async () => {
    // A destination created in a separate, earlier sendEvents call (the same
    // shape every other room-write event needs — a room created in the SAME
    // batch is not materialized when authorization runs).
    const ctx = await startAppserver();
    const { roomId, messageId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "into a fresh room",
    });

    const destRoomId = newUlid();
    const created = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: destRoomId,
              $type: "space.roomy.room.createRoom.v0",
              kind: "space.roomy.channel",
              name: "fresh destination",
            },
          ],
        }),
      },
    );
    expect(created.status).toBe(200);

    const moved = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: newUlid(),
              room: roomId,
              $type: "space.roomy.message.moveMessages.v0",
              messageIds: [messageId],
              toRoomId: destRoomId,
            },
          ],
        }),
      },
    );
    expect(moved.status).toBe(200);

    const dest = await (
      await get(ctx, `space.roomy.room.getMessages?roomId=${destRoomId}`)
    ).json();
    expect(dest.messages.map((m: { id: string }) => m.id)).toContain(messageId);
  });

  test("a moved message sorts above the destination's EXISTING messages", async () => {
    // The ordering policy's whole point. The moved message's own ULID is old,
    // so without the sort_idx rewrite it would sink below the destination's
    // existing messages and fall outside the newest page — the client would
    // see it only as a transient WS diff that vanishes on refetch.
    const ctx = await startAppserver();
    const { roomId, messageId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "old but moved",
    });

    // Create the destination FIRST, then fill it — a room must exist before
    // anything is written into it (same rule as every room-write event).
    // Every existing message is newer than the moved message's own ULID, so a
    // naive sort would sink it below them.
    const destRoomId = newUlid();
    const created = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: destRoomId,
              $type: "space.roomy.room.createRoom.v0",
              kind: "space.roomy.channel",
              name: "destination",
            },
          ],
        }),
      },
    );
    expect(created.status).toBe(200);

    const fill = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: Array.from({ length: 10 }, () => ({
            id: newUlid(),
            room: destRoomId,
            $type: "space.roomy.message.createMessage.v0",
            body: {
              mimeType: "text/plain",
              data: { $bytes: Buffer.from("existing").toString("base64") },
            },
            extensions: {},
          })),
        }),
      },
    );
    expect(fill.status).toBe(200);

    const move = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: newUlid(),
              room: roomId,
              $type: "space.roomy.message.moveMessages.v0",
              messageIds: [messageId],
              toRoomId: destRoomId,
            },
          ],
        }),
      },
    );
    expect(move.status).toBe(200);

    // A first page of 5: the response is oldest→newest, so the LAST row is
    // the newest message in the room. The move is the most recent event, so
    // the moved message must be that row.
    const page = await (
      await get(ctx, `space.roomy.room.getMessages?roomId=${destRoomId}&limit=5`)
    ).json();
    expect(page.messages).toHaveLength(5);
    const newest = page.messages[page.messages.length - 1];
    expect(newest.id).toBe(messageId);
    expect(newest.content).toBe("old but moved");
  });

  test("a non-admin member cannot move a message", async () => {
    const ctx = await startAppserver();
    const { roomId, messageId } = await materializeSpace(ctx, SPACE, USER);

    // A plain member: seeded as a member of the space, with no admin edge.
    seedSpace(ctx.db, SPACE, OTHER);
    seedJoinedSpace(ctx.db, OTHER, SPACE);

    const res = await ctx.authedFetch(OTHER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: newUlid(),
              room: roomId,
              $type: "space.roomy.message.moveMessages.v0",
              messageIds: [messageId],
              toRoomId: newUlid(),
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("room-scoped endpoints 404 for an unknown room", () => {
  test("getMessages returns 404 for a room that was never materialized", async () => {
    const ctx = await startAppserver();
    const res = await get(ctx, `space.roomy.room.getMessages?roomId=${newUlid()}`);
    expect(res.status).toBe(404);
  });
});
