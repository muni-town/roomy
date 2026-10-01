/**
 * The activity feed's cache eviction scope, end to end.
 *
 * `space.getActivityFeed` is a per-caller query spanning every space the
 * caller joined, but its invalidation signals name a single space. Getting the
 * mapping between the two wrong is invisible in a unit test of either side, so
 * this drives the real write path and asserts both directions:
 *
 *   - a write into space A still evicts A's cached page (no stale read), and
 *   - it leaves space B's cached page alone (no over-eviction).
 *
 * Over-eviction is the failure that matters here: it is silent, it costs a
 * handler run per reader per write, and it is what kept the hit rate near the
 * miss rate in production.
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import { materializeSpace, startAppserver, type E2eContext } from "./helpers.ts";

const USER = "did:plc:feed-scope-user";
const SPACE_A = "did:plc:feed-scope-space-a";
const SPACE_B = "did:plc:feed-scope-space-b";

/** Post one message into `roomId` through the real sendEvents path. */
async function postMessage(
  ctx: E2eContext,
  spaceId: string,
  roomId: string,
  text: string,
): Promise<void> {
  const res = await ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    body: JSON.stringify({
      spaceId,
      events: [
        {
          id: newUlid(),
          $type: "space.roomy.message.createMessage.v0",
          room: roomId,
          body: { mimeType: "text/plain", data: { $bytes: Buffer.from(text).toString("base64") } },
          extensions: {},
        },
      ],
    }),
  });
  if (res.status !== 200) throw new Error(`postMessage ${res.status}: ${await res.text()}`);
}

async function readFeed(
  ctx: E2eContext,
  spaceId: string,
): Promise<{ cached: boolean; feed: Array<{ threadId: string; messages: Array<{ content: string }> }> }> {
  const cache = ctx.handle.queryCache!;
  const hitsBefore = cache.stats.hits;
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.getActivityFeed?spaceId=${encodeURIComponent(spaceId)}`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    feed: Array<{ threadId: string; messages: Array<{ content: string }> }>;
  };
  return { cached: cache.stats.hits > hitsBefore, feed: body.feed };
}

describe("activity feed cache eviction is scoped to the space that changed", () => {
  test("a write into one space evicts only that space's cached feed page", async () => {
    const ctx = await startAppserver();
    const a = await materializeSpace(ctx, SPACE_A, USER, { roomName: "a-general" });
    const b = await materializeSpace(ctx, SPACE_B, USER, { roomName: "b-general" });
    const cache = ctx.handle.queryCache!;

    // Warm both pages, then confirm they are genuinely cached.
    await readFeed(ctx, SPACE_A);
    await readFeed(ctx, SPACE_B);
    expect((await readFeed(ctx, SPACE_A)).cached).toBe(true);
    expect((await readFeed(ctx, SPACE_B)).cached).toBe(true);

    // One write, into space A only.
    await postMessage(ctx, SPACE_A, a.roomId, "written into A");

    // A's page is stale and must be re-read from the handler.
    expect((await readFeed(ctx, SPACE_A)).cached).toBe(false);
    // B's page did not change: it must still be served from cache. Before the
    // fix the signal carried no space at all, which evicted every page.
    expect((await readFeed(ctx, SPACE_B)).cached).toBe(true);
    expect(cache.stats.evictions).toBeGreaterThan(0);
  });

  test("the re-read after a write returns the new message (no stale body)", async () => {
    const ctx = await startAppserver();
    const a = await materializeSpace(ctx, SPACE_A, USER, { roomName: "a-general" });
    await materializeSpace(ctx, SPACE_B, USER, { roomName: "b-general" });

    const before = await readFeed(ctx, SPACE_A);
    expect(before.feed.flatMap((i) => i.messages).map((m) => m.content)).not.toContain(
      "fresh-content",
    );

    await postMessage(ctx, SPACE_A, a.roomId, "fresh-content");

    // The evicted page must not serve the pre-write body.
    const after = await readFeed(ctx, SPACE_A);
    expect(after.cached).toBe(false);
    expect(after.feed.flatMap((i) => i.messages).map((m) => m.content)).toContain("fresh-content");
  });

  test("a reaction in one space does not evict another space's page", async () => {
    const ctx = await startAppserver();
    const a = await materializeSpace(ctx, SPACE_A, USER, { roomName: "a-general" });
    await materializeSpace(ctx, SPACE_B, USER, { roomName: "b-general" });

    await readFeed(ctx, SPACE_A);
    await readFeed(ctx, SPACE_B);

    const res = await ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`, {
      method: "POST",
      body: JSON.stringify({
        spaceId: SPACE_A,
        events: [
          {
            id: newUlid(),
            $type: "space.roomy.reaction.addReaction.v0",
            room: a.roomId,
            reactionTo: a.messageId,
            reaction: "👍",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);

    expect((await readFeed(ctx, SPACE_A)).cached).toBe(false);
    expect((await readFeed(ctx, SPACE_B)).cached).toBe(true);
  });
});
