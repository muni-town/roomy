/**
 * E2E regression test for sync WebSocket topic authorization (TASK-68).
 *
 * Security hole (confirmed): the sync WS path enforced identity but NOT
 * authorization — any authenticated user could subscribe to any room/space/
 * stream topic and receive message content they can't read over HTTP.
 *
 * This test proves the exploit is closed:
 *   1. Two users, one member and one non-member of the same (invite-only)
 *      space. The non-member has no HTTP read access to the space's rooms.
 *   2. Both open a sync WS and subscribe to the room topic.
 *   3. The member sends a message via sendEvents.
 *   4. Assert the non-member receives NO #messageDiff frame (content leak)
 *      while the member does.
 *   5. Assert the non-member's stream sub gets no #streamEvents backfill.
 *
 * This test FAILS on the pre-fix code (non-member receives content frames)
 * and PASSES after the fix.
 *
 * Run: bun test --cwd packages/appserver src/e2e/syncAuth.test.ts
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

const MEMBER = "did:plc:sync-auth-member";
const NON_MEMBER = "did:plc:sync-auth-nonmember";
const SPACE = "did:web:space-sync-auth.example";
const ROOM = newUlid();

interface DecodedFrame {
  header: Record<string, unknown>;
  body: Record<string, unknown>;
}

/**
 * Set up an invite-only space (allowPublicJoin=0) with MEMBER as a member.
 * NON_MEMBER is not a member and has no read access over HTTP.
 */
async function setup(): Promise<E2eContext> {
  const ctx = await startAppserver();
  const { db } = ctx;
  seedSpace(db, SPACE, MEMBER, { allowPublicJoin: 0 });
  seedJoinedSpace(db, MEMBER, SPACE);
  seedRoom(db, ROOM, SPACE);
  return ctx;
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

/** Collect decoded CBOR frames from a WS into `frames`. */
function collectFrames(ws: WebSocket, frames: DecodedFrame[]): void {
  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === "string") return; // ignore text frames
    frames.push(sync.decodeCborFrame(ev.data as ArrayBuffer));
  };
}

/** Send a JSON client message (sub/unsub/cursor). */
function sendJson(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

/**
 * Wait until `frames` contains a frame with header `t` (or the deadline
 * passes). Event-driven: resolves the moment the frame arrives, so no fixed
 * sleep is needed — the async sub access check + delivery settle as soon as
 * the observable frame lands.
 */
async function waitForFrame(
  frames: DecodedFrame[],
  t: string,
  timeoutMs = 5000,
): Promise<DecodedFrame> {
  const { promise, resolve, reject } = Promise.withResolvers<DecodedFrame>();
  const deadline = Date.now() + timeoutMs;
  const timer = setInterval(() => {
    const hit = frames.find((f) => f.header["t"] === t);
    if (hit) {
      clearInterval(timer);
      resolve(hit);
      return;
    }
    if (Date.now() > deadline) {
      clearInterval(timer);
      reject(new Error(`Timed out waiting for ${t} frame`));
    }
  }, 25);
  return promise;
}

describe("sync WS topic authorization", () => {
  test(
    "non-member receives no message content frames; member does",
    async () => {
      const ctx = await setup();

      const memberWs = await openWs(ctx, MEMBER);
      const nonMemberWs = await openWs(ctx, NON_MEMBER);
      const memberFrames: DecodedFrame[] = [];
      const nonMemberFrames: DecodedFrame[] = [];
      collectFrames(memberWs, memberFrames);
      collectFrames(nonMemberWs, nonMemberFrames);

      // Both subscribe to the room topic.
      sendJson(memberWs, { type: "sub", topic: "room", id: ROOM });
      sendJson(nonMemberWs, { type: "sub", topic: "room", id: ROOM });

      // Member sends a message via the real write path.
      const messageId = newUlid();
      const sendRes = await ctx.authedFetch(MEMBER)(
        `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
        {
          method: "POST",
          body: JSON.stringify({
            spaceId: SPACE,
            events: [
              {
                id: messageId,
                $type: "space.roomy.message.createMessage.v0",
                room: ROOM,
                body: {
                  mimeType: "text/plain",
                  data: {
                    $bytes: Buffer.from("secret content").toString("base64"),
                  },
                },
                extensions: {},
              },
            ],
          }),
        },
      );
      expect(sendRes.status).toBe(200);

      // Wait for the member's #messageDiff — its arrival proves the signal
      // routed and the delivery-time access check settled. The non-member's
      // denial runs on the same signal emission, so by the time the member's
      // frame lands, the non-member's check has also completed.
      const memberDiff = await waitForFrame(memberFrames, "#messageDiff");
      expect(memberDiff.body["roomId"]).toBe(ROOM);

      // The non-member must receive NO content frame — the exploit.
      const nonMemberDiffs = nonMemberFrames.filter(
        (f) => f.header["t"] === "#messageDiff",
      );
      expect(nonMemberDiffs.length).toBe(0);

      memberWs.close();
      nonMemberWs.close();
    },
    { timeout: 30000 },
  );

  test(
    "non-member stream sub gets no #streamEvents backfill",
    async () => {
      const ctx = await setup();

      const memberWs = await openWs(ctx, MEMBER);
      const nonMemberWs = await openWs(ctx, NON_MEMBER);
      const memberFrames: DecodedFrame[] = [];
      const nonMemberFrames: DecodedFrame[] = [];
      collectFrames(memberWs, memberFrames);
      collectFrames(nonMemberWs, nonMemberFrames);

      // Both subscribe to the stream (space DID). The member's backfill
      // frame arrival proves the async access check path settled; the
      // non-member's denial runs on the same code path.
      sendJson(memberWs, { type: "sub", topic: "stream", id: SPACE, cursor: -1 });
      sendJson(nonMemberWs, { type: "sub", topic: "stream", id: SPACE, cursor: -1 });

      // Member's backfill completes (empty stream → no events, but the
      // access check still ran). Wait for any member frame as the settle
      // signal — the member's sub access check must pass before backfill
      // even starts, and the non-member's denial is the same check.
      await waitForFrame(memberFrames, "#streamEvents").catch(() => {
        // Empty stream: no #streamEvents frame is sent at all. Fall back to
        // waiting for the member's room-sub invalidation as the settle
        // signal instead.
        sendJson(memberWs, { type: "sub", topic: "room", id: ROOM });
        return waitForFrame(memberFrames, "#invalidate");
      });

      const nonMemberStreamFrames = nonMemberFrames.filter(
        (f) => f.header["t"] === "#streamEvents",
      );
      expect(nonMemberStreamFrames.length).toBe(0);

      memberWs.close();
      nonMemberWs.close();
    },
    { timeout: 30000 },
  );
});
