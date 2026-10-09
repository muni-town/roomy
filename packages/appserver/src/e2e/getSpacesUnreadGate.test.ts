/**
 * The read path's `getSpaces` invalidation, end to end, against a real
 * appserver and its response cache.
 *
 * `getSpaces` carries a single `hasUnreads` boolean (no counts), so a read can
 * only move the list when it drains the space's LAST unread room, and a message
 * can only move it by flipping the space from no unread rooms to one. Anything
 * else that invalidated the list would be a refetch that cannot change its body.
 *
 * Unit tests cover the signal shapes; this drives the real cache so the gate is
 * proven where it matters — an un-gated signal rebuilds every reader's list on
 * every read.
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  materializeSpace,
  readStateDb,
  spaceDb,
  startAppserver,
  type E2eContext,
} from "./helpers.ts";

const SPACE = "did:plc:unread-gate-space";
const USER = "did:plc:unread-gate-user";

/**
 * Set a room's read position, which is the whole of its unread state: a
 * position below the room's messages leaves them unread, and a position at or
 * past them leaves none.
 */
async function setPosition(ctx: E2eContext, roomId: string, seenUpTo: string): Promise<void> {
  await readStateDb(ctx.db).run(
    `insert into read_positions (user_did, room_id, space_did, seen_up_to)
     values (?, ?, ?, ?)
     on conflict(user_did, room_id) do update set seen_up_to = excluded.seen_up_to`,
    [USER, roomId, SPACE, seenUpTo],
  );
}

/** The newest message key in a room — the position a caught-up reader holds. */
async function newestKey(ctx: E2eContext, roomId: string): Promise<string> {
  const row = await spaceDb(ctx.db, SPACE)
    .query("select max(sort_idx) as m from entities where room = ?")
    .get<{ m: string | null }>(roomId);
  return row?.m ?? "0";
}

/** Post one message into `roomId` through the real write path. */
async function post(ctx: E2eContext, roomId: string): Promise<void> {
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      body: JSON.stringify({
        spaceId: SPACE,
        events: [
          {
            id: newUlid(),
            $type: "space.roomy.message.createMessage.v0",
            room: roomId,
            body: { mimeType: "text/plain", data: { $bytes: "aGVsbG8=" } },
            extensions: {},
          },
        ],
      }),
    },
  );
  expect(res.status).toBe(200);
}

/** Read getSpaces, reporting whether the response came from the cache. */
async function readSpaces(
  ctx: E2eContext,
  query = "",
): Promise<{ cached: boolean; spaces: Array<{ id: string; hasUnreads: boolean }> }> {
  const cache = ctx.handle.queryCache!;
  const hitsBefore = cache.stats.hits;
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces${query}`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    spaces: Array<{ id: string; hasUnreads: boolean }>;
  };
  return { cached: cache.stats.hits > hitsBefore, spaces: body.spaces };
}

/** Create a channel in SPACE through the real write path. */
async function createRoom(ctx: E2eContext, name: string): Promise<string> {
  const roomId = newUlid();
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      body: JSON.stringify({
        spaceId: SPACE,
        events: [
          { id: roomId, $type: "space.roomy.room.createRoom.v0", kind: "space.roomy.channel", name },
        ],
      }),
    },
  );
  expect(res.status).toBe(200);
  return roomId;
}

/** Mark `roomId` read through the real procedure. */
async function read(ctx: E2eContext, roomId: string): Promise<void> {
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.room.updateSeen`,
    { method: "POST", body: JSON.stringify({ roomId }) },
  );
  expect(res.status).toBe(200);
}

const QUERY = "?includeLeft=false";

describe("getSpaces invalidation is gated on the hasUnreads flip", () => {
  test("a read that leaves another unread room keeps the list cached", async () => {
    const ctx = await startAppserver();
    const { roomId: roomA } = await materializeSpace(ctx, SPACE, USER, { roomName: "a" });
    const roomB = await createRoom(ctx, "b");
    await post(ctx, roomB);
    // Both rooms hold a message past the reader's position, so the space is
    // marked.
    await setPosition(ctx, roomA, "0");
    await setPosition(ctx, roomB, "0");

    const warm = await readSpaces(ctx, QUERY);
    expect(warm.spaces.find((s) => s.id === SPACE)?.hasUnreads).toBe(true);
    expect((await readSpaces(ctx, QUERY)).cached).toBe(true);

    // Reading A leaves B unread: the space's hasUnreads is still true, so the
    // cached list is not stale and must survive.
    await read(ctx, roomA);
    expect((await readSpaces(ctx, QUERY)).cached).toBe(true);

    // Reading B drains the space: the list must now be evicted.
    await read(ctx, roomB);
    expect((await readSpaces(ctx, QUERY)).cached).toBe(false);
  });

  test("a message that flips the space unread does not evict the list", async () => {
    const ctx = await startAppserver();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, { roomName: "a" });
    // Nothing unread anywhere — the reader is caught up, so the space starts
    // unmarked.
    await setPosition(ctx, roomId, await newestKey(ctx, roomId));

    const warm = await readSpaces(ctx, QUERY);
    expect(warm.spaces.find((s) => s.id === SPACE)?.hasUnreads).toBe(false);
    expect((await readSpaces(ctx, QUERY)).cached).toBe(true);

    // A message now makes the space unread. The live client learns this from
    // the `#roomMetadataDiff` frame (spaceUnreadFlip) and patches the boolean,
    // so the cached list must NOT be evicted — a refetch would be pure cost.
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: newUlid(),
              $type: "space.roomy.message.createMessage.v0",
              room: roomId,
              body: {
                mimeType: "text/plain",
                data: { $bytes: Buffer.from("hello").toString("base64") },
              },
              extensions: {},
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);

    expect((await readSpaces(ctx, QUERY)).cached).toBe(true);
  });
});
