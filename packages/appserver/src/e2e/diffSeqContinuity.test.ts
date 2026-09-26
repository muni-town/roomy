/**
 * E2E regression test for the diff-seq gap false positive.
 *
 * Reported symptom: deleting a message still froze the UI after the
 * invalidation-storm fixes. The surviving path was the client's gap detector:
 * `#messageDiff` frames carried a single PROCESS-GLOBAL seq
 * (`InvalidationRouter.#seq`), but delivery is selective — a connection only
 * receives diffs for the rooms it is subscribed to, and `#roomMetadataDiff`
 * only for its own user. So the seqs a connection observed were a sparse
 * subsequence (`[1, 7]`, not `[1, 2]`), the client's `seq > lastSeq + 1` test
 * fired on essentially every frame, and each frame refetched the room being
 * viewed. Traffic in any other room — not just a delete — therefore produced a
 * refetch per frame.
 *
 * The frame's `seq` is now stamped per connection at delivery, so a
 * connection's diffs are contiguous and a gap really does mean a missed frame.
 *
 * Run: bun test --cwd packages/appserver src/e2e/diffSeqContinuity.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid, sync } from "@roomy-space/sdk";
import {
  startAppserver,
  seedSpace,
  seedJoinedSpace,
  seedMembership,
  seedRoom,
  type E2eContext,
} from "./helpers.ts";

const USER = "did:plc:seq-continuity-user";
const SPACE = "did:web:space-seq-continuity.example";
/** The room the connection subscribes to. */
const ROOM = newUlid();
/** A second room in the same space that the connection does NOT subscribe to. */
const OTHER_ROOM = newUlid();

interface DecodedFrame {
  header: Record<string, unknown>;
  body: Record<string, unknown>;
}

async function openWs(ctx: E2eContext, did: string): Promise<WebSocket> {
  const ticketRes = await ctx.authedFetch(did)(
    `${ctx.baseUrl}/xrpc/space.roomy.auth.getConnectionTicket`,
    { method: "POST", body: "{}" },
  );
  expect(ticketRes.status).toBe(200);
  const { ticket } = (await ticketRes.json()) as { ticket: string };
  const ws = new WebSocket(
    `ws://localhost:${ctx.handle.port}/xrpc/space.roomy.sync.subscribe?ticket=${ticket}`,
  );
  ws.binaryType = "arraybuffer";
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("WebSocket connection failed"));
  await promise;
  return ws;
}

function collectFrames(ws: WebSocket, frames: DecodedFrame[]): void {
  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === "string") return;
    frames.push(sync.decodeCborFrame(ev.data as ArrayBuffer));
  };
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

async function sendEvents(ctx: E2eContext, events: unknown[]): Promise<void> {
  const res = await ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    body: JSON.stringify({ spaceId: SPACE, events }),
  });
  expect(res.status).toBe(200);
}

function createMessageEvent(roomId: string, text: string) {
  return {
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: {
      mimeType: "text/plain",
      data: { $bytes: Buffer.from(text).toString("base64") },
    },
    extensions: {},
  };
}

/**
 * The seqs of the frames that participate in gap detection, in arrival order.
 * `#messageDiff` and `#roomMetadataDiff` share the connection's counter.
 */
function diffSeqs(frames: DecodedFrame[]): number[] {
  const out: number[] = [];
  for (const f of frames) {
    const t = f.header["t"];
    if (t !== "#messageDiff" && t !== "#roomMetadataDiff") continue;
    const seq = f.body["seq"];
    if (typeof seq === "number") out.push(seq);
  }
  return out;
}

/** Whether `seqs` is contiguous (each step exactly +1). */
function isContiguous(seqs: readonly number[]): boolean {
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i]! !== seqs[i - 1]! + 1) return false;
  }
  return true;
}

describe("diff seq continuity", () => {
  test(
    "a connection's delivered diffs are contiguous despite other rooms' traffic",
    async () => {
      const ctx = await startAppserver();
      seedSpace(ctx.db, SPACE, USER, { allowPublicJoin: 1 });
      seedJoinedSpace(ctx.db, USER, SPACE);
      seedMembership(ctx.db, SPACE, USER, "admin");
      seedRoom(ctx.db, ROOM, SPACE, "subscribed");
      seedRoom(ctx.db, OTHER_ROOM, SPACE, "other");

      const ws = await openWs(ctx, USER);
      const frames: DecodedFrame[] = [];
      collectFrames(ws, frames);

      // Subscribe to ROOM only — deliberately not to OTHER_ROOM, and not to
      // the space topic, so other-room diffs are withheld from this
      // connection while still being emitted.
      ws.send(JSON.stringify({ type: "sub", topic: "room", id: ROOM }));

      // Prove the subscription is live before relying on delivery.
      await sendEvents(ctx, [createMessageEvent(ROOM, "probe")]);
      await waitFor(
        frames,
        () => frames.some((f) => f.header["t"] === "#messageDiff"),
        "the probe message diff",
      );

      // Traffic in a room this connection is not subscribed to. Its diffs are
      // never delivered here, but they are still emitted.
      for (let i = 0; i < 5; i++) {
        await sendEvents(ctx, [createMessageEvent(OTHER_ROOM, `other ${i}`)]);
      }

      // A message in the subscribed room, delivered after that traffic.
      await sendEvents(ctx, [createMessageEvent(ROOM, "after other-room traffic")]);
      await waitFor(
        frames,
        () => frames.filter((f) => f.header["t"] === "#messageDiff").length >= 2,
        "the post-traffic message diff",
      );

      const seqs = diffSeqs(frames);

      // THE REGRESSION: with a process-global counter this was [1, 7] — the
      // five other-room diffs advanced the counter without being delivered,
      // so the client read a gap on every frame and refetched the room it was
      // viewing.
      expect(seqs.length).toBeGreaterThanOrEqual(2);
      expect(isContiguous(seqs)).toBe(true);

      ws.close();
    },
    { timeout: 30000 },
  );

  test(
    "per-connection counters are independent across connections",
    async () => {
      const ctx = await startAppserver();
      seedSpace(ctx.db, SPACE, USER, { allowPublicJoin: 1 });
      seedJoinedSpace(ctx.db, USER, SPACE);
      seedMembership(ctx.db, SPACE, USER, "admin");
      seedRoom(ctx.db, ROOM, SPACE, "subscribed");

      // Two connections for the same user, both subscribed to ROOM.
      const wsA = await openWs(ctx, USER);
      const wsB = await openWs(ctx, USER);
      const framesA: DecodedFrame[] = [];
      const framesB: DecodedFrame[] = [];
      collectFrames(wsA, framesA);
      collectFrames(wsB, framesB);
      wsA.send(JSON.stringify({ type: "sub", topic: "room", id: ROOM }));
      wsB.send(JSON.stringify({ type: "sub", topic: "room", id: ROOM }));

      await sendEvents(ctx, [createMessageEvent(ROOM, "probe A")]);
      await waitFor(
        framesA,
        () => framesA.some((f) => f.header["t"] === "#messageDiff"),
        "connection A probe diff",
      );
      await waitFor(
        framesB,
        () => framesB.some((f) => f.header["t"] === "#messageDiff"),
        "connection B probe diff",
      );

      // Both connections start their own counters at 1 and advance together.
      for (let i = 0; i < 3; i++) {
        await sendEvents(ctx, [createMessageEvent(ROOM, `shared ${i}`)]);
      }
      await waitFor(
        framesA,
        () => diffSeqs(framesA).length >= 4,
        "connection A to receive every diff",
      );
      await waitFor(
        framesB,
        () => diffSeqs(framesB).length >= 4,
        "connection B to receive every diff",
      );

      const a = diffSeqs(framesA);
      const b = diffSeqs(framesB);
      // Each connection's own sequence is contiguous and starts at 1 — they do
      // not share a counter, so one connection's frames cannot gap the other's.
      expect(a[0]).toBe(1);
      expect(b[0]).toBe(1);
      expect(isContiguous(a)).toBe(true);
      expect(isContiguous(b)).toBe(true);

      wsA.close();
      wsB.close();
    },
    { timeout: 30000 },
  );
});
