/**
 * E2E test for the per-message invalidation fanout.
 *
 * Problem: ONE live message produces 5 `#invalidate` frames per subscribed
 * client, each of which forces an HTTP refetch — `room.getMetadata` and
 * `room.getThreads` by every createMessage, and `space.getThreads` too. Four
 * of those five land on endpoints carrying per-room access resolution, so a
 * message becomes ~16 reads and ~550 DB round-trips across 4 clients.
 *
 * An activity-ordered view is a LIST, and a list only needs the row that
 * moved, so it is carried as a diff rather than an ordering-driven
 * invalidation. This test exercises the REAL write path (`sendEvents` →
 * materialize → InvalidationRouter → SyncManager → WS frames) and asserts the
 * observable frame set.
 *
 * It is deliberately stated in terms of what a client receives, not in terms of
 * which internal signal fired: the contract is "a board is patchable from what
 * arrives, and nothing tells the client to refetch it".
 *
 * Run: bun test --cwd packages/appserver src/e2e/roomActivityFanout.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid, schemas, sync, type } from "@roomy-space/sdk";
import {
  startAppserver,
  seedSpace,
  seedJoinedSpace,
  seedRoom,
  seedReadPosition,
  type E2eContext,
} from "./helpers.ts";

const USER = "did:plc:activity-fanout-user";
const SPACE = "did:web:space-activity-fanout.example";
const CHANNEL = newUlid();

/** Boards that the per-message path must not invalidate. */
const BOARD_NSIDS = [
  "space.roomy.room.getMetadata",
  "space.roomy.room.getThreads",
  "space.roomy.space.getThreads",
];

interface DecodedFrame {
  header: Record<string, unknown>;
  body: Record<string, unknown>;
}

/**
 * Frame sink with event-driven waiting.
 *
 * `waitFor` resolves the moment a matching frame ARRIVES — no polling, so a
 * run costs nothing in fixed latency and a failure names the frame it wanted.
 * The test runner's own timeout is the only guard; a hung wait fails there.
 */
function frameSink(ws: WebSocket) {
  const frames: DecodedFrame[] = [];
  const waiters = new Set<{ matches: () => boolean; resolve: () => void }>();

  const settled = () => {
    for (const waiter of [...waiters]) {
      if (waiter.matches()) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === "string") return;
    frames.push(sync.decodeCborFrame(ev.data as ArrayBuffer) as DecodedFrame);
    settled();
  };

  return {
    frames,
    /** Await the first (or next) frame satisfying `predicate`. */
    waitFor(predicate: (frames: DecodedFrame[]) => boolean): Promise<void> {
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.add({ matches: () => predicate(frames), resolve });
      settled();
      return promise;
    },
  };
}

function ofType(frames: DecodedFrame[], t: string): DecodedFrame[] {
  return frames.filter((f) => f.header["t"] === t);
}

function invalidationsFor(frames: DecodedFrame[], nsid: string): number {
  return frames.filter(
    (f) =>
      f.header["t"] === "#invalidate" &&
      (f.body as { nsid?: string }).nsid === nsid,
  ).length;
}

/** The plaintext of every message a `#messageDiff` frame added or updated. */
function diffContents(frame: DecodedFrame): string[] {
  const ops = (frame.body as { ops?: Array<{ message?: { content?: string } }> }).ops ?? [];
  return ops.flatMap((op) => (op.message?.content != null ? [op.message.content] : []));
}

/** The previewed text of a `#roomActivityDiff`, or undefined for other frames. */
function activityContent(frame: DecodedFrame): string | undefined {
  if (frame.header["t"] !== "#roomActivityDiff") return undefined;
  return (frame.body as { activity?: { latestMessage?: { content?: string } } })
    .activity?.latestMessage?.content;
}

async function openWs(ctx: E2eContext, did: string): Promise<WebSocket> {
  const ticketRes = await ctx.authedFetch(did)(
    `${ctx.baseUrl}/xrpc/space.roomy.auth.getConnectionTicket`,
    { method: "POST", body: "{}" },
  );
  expect(ticketRes.status).toBe(200);
  const { ticket } = await ticketRes.json();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const ws = new WebSocket(
    `ws://localhost:${ctx.handle.port}/xrpc/space.roomy.sync.subscribe?ticket=${ticket}`,
  );
  ws.binaryType = "arraybuffer";
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("WebSocket connection failed"));
  await promise;
  return ws;
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

/**
 * Start an appserver, subscribe a client to the channel + space topics, and
 * prove the subscriptions are live before returning.
 *
 * Topic registration is async (it awaits an access check), so a frame from a
 * probe message is what proves the room topic will receive the frames under
 * test — and BOTH frame types that message produces are awaited, because
 * frames from different signals resolve independently and a late probe frame
 * would otherwise be counted against the batch under test.
 */
async function subscribedClient(): Promise<{
  ctx: E2eContext;
  ws: WebSocket;
  sink: ReturnType<typeof frameSink>;
}> {
  const ctx = await startAppserver();
  seedSpace(ctx.db, SPACE, USER, { allowPublicJoin: 1 });
  seedJoinedSpace(ctx.db, USER, SPACE);
  seedRoom(ctx.db, CHANNEL, SPACE, "general");
  // A read-position row is what makes the reader a recipient of the per-user
  // unread patch; without it the room has no tracked readers to notify.
  seedReadPosition(ctx.db, USER, CHANNEL, "0", 0);

  const ws = await openWs(ctx, USER);
  const sink = frameSink(ws);
  ws.send(JSON.stringify({ type: "sub", topic: "room", id: CHANNEL }));
  ws.send(JSON.stringify({ type: "sub", topic: "space", id: SPACE }));

  const live = sink.waitFor((f) =>
    f.some((x) => x.header["t"] === "#messageDiff") &&
    f.some(
      (x) =>
        x.header["t"] === "#roomActivityDiff" &&
        activityContent(x) === "probe",
    ),
  );
  const probe = await sendEvents(ctx, USER, [createMessageEvent(CHANNEL, "probe")]);
  expect(probe.status).toBe(200);
  await live;

  // The probe's own frames are not under test.
  sink.frames.length = 0;
  return { ctx, ws, sink };
}

describe("per-message invalidation fanout", () => {
  test(
    "one message patches the boards instead of invalidating them",
    async () => {
      const { ctx, ws, sink } = await subscribedClient();

      const activityArrived = sink.waitFor((f) =>
        f.some((x) => x.header["t"] === "#roomActivityDiff"),
      );
      const res = await sendEvents(ctx, USER, [
        createMessageEvent(CHANNEL, "a live message"),
      ]);
      expect(res.status).toBe(200);
      await activityArrived;

      // The frame set must not include board invalidations:
      //   #messageDiff:1 #roomMetadataDiff:1 #invalidate:5
      // would mean four boards plus the feed were told to refetch.
      for (const nsid of BOARD_NSIDS) {
        expect(invalidationsFor(sink.frames, nsid)).toBe(0);
      }

      // The activity diff carries what a board refetch would have returned:
      // the room, its newest message, and the author as the newest member.
      const activity = ofType(sink.frames, "#roomActivityDiff")[0]!;
      const parsed = schemas.frames.roomActivityDiff.Body(activity.body);
      // The frame must satisfy the published wire schema — it is the contract
      // the client validates before patching its cache.
      expect(parsed instanceof type.errors).toBe(false);
      if (parsed instanceof type.errors) return;
      expect(parsed.roomId).toBe(CHANNEL);
      expect(parsed.spaceId).toBe(SPACE);
      expect(parsed.kind).toBe("channel");
      expect(parsed.activity.latestMessage?.content).toBe("a live message");
      expect(parsed.activity.latestMembers.map((m) => m.did)).toContain(USER);
      expect(parsed.activity.latestTimestamp).toBeDefined();

      // The per-user unread patch and the message body still arrive: only the
      // ORDERING fields move to a diff, the caller-scoped ones do not.
      expect(ofType(sink.frames, "#messageDiff").length).toBe(1);
      expect(ofType(sink.frames, "#roomMetadataDiff").length).toBe(1);

      ws.close();
    },
    { timeout: 30000 },
  );

  test(
    "a batch of messages in one room collapses to a single activity diff",
    async () => {
      const { ctx, ws, sink } = await subscribedClient();

      // Five messages in ONE batch: each would emit its own snapshot of the
      // room's latest activity, but only the newest is true — so the batch
      // must deliver exactly one.
      const lastArrived = sink.waitFor((f) =>
        ofType(f, "#messageDiff").some((m) =>
          diffContents(m).includes("msg 4"),
        ),
      );
      const res = await sendEvents(
        ctx,
        USER,
        Array.from({ length: 5 }, (_, i) => createMessageEvent(CHANNEL, `msg ${i}`)),
      );
      expect(res.status).toBe(200);

      // Waiting for the LAST message's diff proves the batch's whole signal
      // set has been dispatched — the activity diff is emitted before it, by
      // the same listener call, so it cannot still be outstanding.
      await lastArrived;

      const activityFrames = ofType(sink.frames, "#roomActivityDiff");
      expect(activityFrames.length).toBe(1);
      const body = activityFrames[0]!.body as {
        activity: { latestMessage?: { content: string } };
      };
      // The kept snapshot is the LAST one — the room's true latest activity,
      // not the first message of the batch.
      expect(body.activity.latestMessage?.content).toBe("msg 4");

      // Still no board invalidations, however many messages the batch held.
      for (const nsid of BOARD_NSIDS) {
        expect(invalidationsFor(sink.frames, nsid)).toBe(0);
      }

      ws.close();
    },
    { timeout: 30000 },
  );
});
