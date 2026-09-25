/**
 * E2E test for the delete-invalidation storm.
 *
 * Symptom: deleting messages freezes the app under a non-stopping stream of
 * `space.roomy.space.getActivityFeed` invalidations.
 *
 * The amplification has three server-side sources, all exercised here through
 * the REAL write path (`space.roomy.space.sendEvents` → materialize →
 * InvalidationRouter → SyncManager → WS frames):
 *
 *   1. Per-event fan-out — a batch of N deletes emits the whole batch-level
 *      signal set N times (N identical `getActivityFeed` invalidations).
 *   2. Every one of those is broadcast to EVERY connection, because
 *      getActivityFeed (like getSpaces) is user-scoped and has no topic index
 *      to narrow delivery.
 *   3. A delete must not leave derived state behind: the room's
 *      `activity_item` window names the deleted messages, so the feed would
 *      keep serving a room with nothing in it.
 *
 * This test asserts all three hold: ONE feed invalidation for a batch of
 * five deletes, and a feed that does not list the emptied room.
 *
 * Run: bun test --cwd packages/appserver src/e2e/deleteInvalidationStorm.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid, sync } from "@roomy-space/sdk";
import {
  startAppserver,
  seedSpace,
  seedJoinedSpace,
  seedRoom,
  type E2eContext,
} from "./helpers.ts";

const USER = "did:plc:delete-storm-user";
const SPACE = "did:web:space-delete-storm.example";
const ROOM = newUlid();

/** XRPC NSID whose invalidation frames this test counts. */
const FEED_NSID = "space.roomy.space.getActivityFeed";

interface DecodedFrame {
  header: Record<string, unknown>;
  body: Record<string, unknown>;
}

/** Mint a connection ticket and open a sync WS for `did`. */
async function openWs(ctx: E2eContext, did: string): Promise<WebSocket> {
  const ticketRes = await ctx.authedFetch(did)(
    `${ctx.baseUrl}/xrpc/space.roomy.auth.getConnectionTicket`,
    { method: "POST", body: "{}" },
  );
  expect(ticketRes.status).toBe(200);
  const { ticket } = await ticketRes.json();
  const ws = new WebSocket(
    `ws://localhost:${ctx.handle.port}/xrpc/space.roomy.sync.subscribe?ticket=${ticket}`,
  );
  ws.binaryType = "arraybuffer";
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("WebSocket connection failed"));
  const timeout = setTimeout(
    () => reject(new Error("Timeout waiting for WS open")),
    5000,
  );
  try {
    await promise;
  } finally {
    clearTimeout(timeout);
  }
  return ws;
}

/** Decode every binary frame the socket receives into `frames`. */
function collectFrames(ws: WebSocket, frames: DecodedFrame[]): void {
  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === "string") return;
    frames.push(sync.decodeCborFrame(ev.data as ArrayBuffer));
  };
}

/** Count `#invalidate` frames for one NSID. */
function countInvalidations(frames: DecodedFrame[], nsid: string): number {
  return frames.filter(
    (f) =>
      f.header["t"] === "#invalidate" &&
      (f.body as { nsid?: string }).nsid === nsid,
  ).length;
}

/** Wait for `predicate` over the rolling frame list, or fail on the deadline. */
async function waitFor(
  frames: DecodedFrame[],
  predicate: () => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** POST one batch of events through the real sendEvents path. */
async function sendEvents(
  ctx: E2eContext,
  did: string,
  events: unknown[],
): Promise<Response> {
  return ctx.authedFetch(did)(`${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    body: JSON.stringify({ spaceId: SPACE, events }),
  });
}

function createMessageEvent(roomId: string, text: string) {
  return {
    id: newUlid(),
    $type: "space.roomy.message.createMessage.v0",
    room: roomId,
    body: {
      mimeType: "text/plain",
      data: { $bytes: Buffer.from(text).toString("base64") },
    },
    extensions: {},
  };
}

function deleteMessageEvent(roomId: string, messageId: string) {
  return {
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.message.deleteMessage.v0",
    messageId,
  };
}

describe("delete invalidation storm", () => {
  test(
    "a batch of K deletes produces ONE getActivityFeed invalidation",
    async () => {
      const ctx = await startAppserver();
      seedSpace(ctx.db, SPACE, USER, { allowPublicJoin: 1 });
      seedJoinedSpace(ctx.db, USER, SPACE);
      seedRoom(ctx.db, ROOM, SPACE, "general");

      const ws = await openWs(ctx, USER);
      const frames: DecodedFrame[] = [];
      collectFrames(ws, frames);
      ws.send(JSON.stringify({ type: "sub", topic: "room", id: ROOM }));
      ws.send(JSON.stringify({ type: "sub", topic: "space", id: SPACE }));

      // Topic subscription is registered asynchronously (it awaits an access
      // check), so prove the subscription took effect before counting: this
      // probe message's diff only reaches us once the room topic is live.
      const probeRes = await sendEvents(
        ctx,
        USER,
        [createMessageEvent(ROOM, "subscription probe")],
      );
      expect(probeRes.status).toBe(200);
      await waitFor(
        frames,
        () => frames.some((f) => f.header["t"] === "#messageDiff"),
        "messageDiff proving the room topic is subscribed",
      );

      // Five messages, then delete all five in ONE batch.
      const messageIds = Array.from({ length: 5 }, () => newUlid());
      const createRes = await sendEvents(
        ctx,
        USER,
        messageIds.map((id, i) => ({
          ...createMessageEvent(ROOM, `message ${i}`),
          id,
        })),
      );
      expect(createRes.status).toBe(200);

      const before = countInvalidations(frames, FEED_NSID);
      const deleteRes = await sendEvents(
        ctx,
        USER,
        messageIds.map((id) => deleteMessageEvent(ROOM, id)),
      );
      expect(deleteRes.status).toBe(200);

      // The delete batch's feed invalidations arrive asynchronously.
      await waitFor(
        frames,
        () =>
          frames.filter(
            (f) =>
              f.header["t"] === "#messageDiff" &&
              (f.body as { ops?: Array<{ op: string }> }).ops?.some(
                (o) => o.op === "remove",
              ),
          ).length >= 5,
        "5 remove diffs",
      );

      const after = countInvalidations(frames, FEED_NSID);
      const emitted = after - before;

      // A batch of deletes must produce ONE feed invalidation, not one per
      // deleted message.
      expect(emitted).toBe(1);

      // The per-message diffs must still be one per deleted message.
      const removeDiffs = frames.filter(
        (f) =>
          f.header["t"] === "#messageDiff" &&
          (f.body as { ops?: Array<{ op: string }> }).ops?.some((o) => o.op === "remove"),
      );
      expect(removeDiffs.length).toBe(5);

      ws.close();
    },
    { timeout: 30000 },
  );

  test(
    "deleting every message removes the room from the activity feed",
    async () => {
      const ctx = await startAppserver();
      seedSpace(ctx.db, SPACE, USER, { allowPublicJoin: 1 });
      seedJoinedSpace(ctx.db, USER, SPACE);
      seedRoom(ctx.db, ROOM, SPACE, "general");

      // Two messages through the real write path, so the activity_item row is
      // produced by the materializer (not seeded).
      const messageIds = [newUlid(), newUlid()];
      const createRes = await sendEvents(
        ctx,
        USER,
        messageIds.map((id, i) => ({ ...createMessageEvent(ROOM, `msg ${i}`), id })),
      );
      expect(createRes.status).toBe(200);

      /** Read the feed and return the item for this room, if any. */
      const feedItem = async () => {
        const res = await ctx.authedFetch(USER)(
          `${ctx.baseUrl}/xrpc/space.roomy.space.getActivityFeed?spaceId=${SPACE}`,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          feed: Array<{ threadId: string; recentMessages?: unknown[] }>;
        };
        return body.feed.find((item) => item.threadId === ROOM) ?? null;
      };

      // Precondition: the room IS in the feed while it has messages.
      expect(await feedItem()).not.toBeNull();

      const deleteRes = await sendEvents(
        ctx,
        USER,
        messageIds.map((id) => deleteMessageEvent(ROOM, id)),
      );
      expect(deleteRes.status).toBe(200);

      // The room must not stay listed: with every message deleted its
      // activity window is meaningless and it disappears entirely.
      expect(await feedItem()).toBeNull();
    },
    { timeout: 30000 },
  );
});
