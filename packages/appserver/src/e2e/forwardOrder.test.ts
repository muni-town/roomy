/**
 * A multi-message forward must land in the destination room in the SOURCE
 * room's timeline order (oldest → newest).
 *
 * Two independent things have to be true for that, and the appserver owns the
 * second:
 *
 *   1. The client orders the targets by the source timeline and stamps each
 *      forward with a distinct increasing canonical time (see app-lite's
 *      `mutations/forward.ts`).
 *   2. The appserver derives `sort_idx` for a `createMessage` from its
 *      canonical timestamp at MILLISECOND resolution
 *      (`materialization/sortIdx.ts`). A forward burst minted inside one
 *      millisecond therefore shares one sort key, and the destination orders
 *      those rows by the id tie-break — so the forwards arrive jumbled even
 *      though the client sent them in the right order.
 *
 * This test drives the real write path with a burst of forwards carrying
 * explicitly increasing canonical timestamps (what the fixed client sends)
 * and asserts the destination pages them back in source order.
 *
 * Run: bun test --cwd packages/appserver src/e2e/forwardOrder.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import { decodeTime } from "ulidx";
import { materializeSpace, startAppserver, type E2eContext } from "./helpers.ts";

const USER = "did:plc:forward-order-user";
const SPACE = "did:web:space-forward-order.example";

interface MessageRow {
  id: string;
  sort_idx?: string;
  timestamp: string;
  forwardedFrom?: { messageId: string };
}

async function sendEvents(
  ctx: E2eContext,
  events: Record<string, unknown>[],
): Promise<void> {
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    { method: "POST", body: JSON.stringify({ spaceId: SPACE, events }) },
  );
  if (res.status !== 200) throw new Error(`${res.status}: ${await res.text()}`);
}

async function createRoom(ctx: E2eContext, name: string): Promise<string> {
  const id = newUlid();
  await sendEvents(ctx, [
    {
      id,
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.channel",
      name,
    },
  ]);
  return id;
}

async function createMessage(
  ctx: E2eContext,
  roomId: string,
  text: string,
): Promise<string> {
  const id = newUlid();
  await sendEvents(ctx, [
    {
      id,
      $type: "space.roomy.message.createMessage.v0",
      room: roomId,
      body: {
        mimeType: "text/plain",
        data: { $bytes: Buffer.from(text).toString("base64") },
      },
      extensions: {},
    },
  ]);
  return id;
}

async function getMessages(ctx: E2eContext, roomId: string): Promise<MessageRow[]> {
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${roomId}&limit=100`,
  );
  if (res.status !== 200) throw new Error(`getMessages ${res.status}`);
  const body = (await res.json()) as { messages: MessageRow[] };
  return body.messages;
}

/**
 * A source channel of `count` messages and an empty destination channel.
 * Returns the source room's ids in timeline order (oldest → newest).
 */
async function fixture(
  ctx: E2eContext,
  count: number,
): Promise<{ source: string; destination: string; sourceOrder: string[] }> {
  await materializeSpace(ctx, SPACE, USER, { roomName: "seed", messageText: "seed" });
  const source = await createRoom(ctx, "source");
  const destination = await createRoom(ctx, "destination");
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(await createMessage(ctx, source, `m${i}`));
  const sourceOrder = (await getMessages(ctx, source)).map((m) => m.id);
  expect(sourceOrder).toHaveLength(count);
  return { source, destination, sourceOrder };
}

/**
 * Build the forward burst the client sends: one `createMessage` per source
 * message, in source order, each with its own increasing canonical time.
 */
function forwardBurst(
  source: string,
  destination: string,
  sourceOrder: readonly string[],
  baseTimestamp: number,
): Record<string, unknown>[] {
  return sourceOrder.map((target, index) => ({
    id: newUlid(),
    room: destination,
    $type: "space.roomy.message.createMessage.v0",
    body: {
      mimeType: "text/markdown",
      data: { $bytes: Buffer.from("").toString("base64") },
    },
    extensions: {
      "space.roomy.extension.timestampOverride.v0": {
        $type: "space.roomy.extension.timestampOverride.v0",
        timestamp: baseTimestamp + index,
      },
      "space.roomy.extension.attachments.v0": {
        $type: "space.roomy.extension.attachments.v0",
        attachments: [
          { $type: "space.roomy.attachment.forward.v0", target, fromRoomId: source },
        ],
      },
    },
  }));
}

/** The forwarded originals, in the order the destination room returns them. */
function destinationOrder(rows: MessageRow[]): string[] {
  return rows.map((row) => row.forwardedFrom?.messageId ?? row.id);
}

describe("multi-forward destination order", () => {
  test("forwards carrying increasing canonical times land in source order", async () => {
    const ctx = await startAppserver();
    const { source, destination, sourceOrder } = await fixture(ctx, 6);

    await sendEvents(
      ctx,
      forwardBurst(source, destination, sourceOrder, Date.now()),
    );

    const rows = await getMessages(ctx, destination);
    expect(rows).toHaveLength(sourceOrder.length);
    // The destination's own timeline order IS the source's, oldest → newest.
    expect(destinationOrder(rows)).toEqual(sourceOrder);
    // And every forward carries its own sort key, so the page order is stable.
    expect(new Set(rows.map((r) => r.sort_idx)).size).toBe(sourceOrder.length);
  });

  test("a jumbled id order still follows the canonical times", async () => {
    // The destination sorts by `coalesce(sort_idx, id)`, and the forwards'
    // canonical times (not their minted ids) are what the client controls. This
    // pins that: even when every minted id would sort AGAINST the source order,
    // the forwards come back in source order.
    const ctx = await startAppserver();
    const { source, destination, sourceOrder } = await fixture(ctx, 5);

    const events = forwardBurst(source, destination, sourceOrder, Date.now());
    // Reverse each id's random suffix so the id order opposes the time order.
    for (const event of events) {
      const id = String(event.id);
      const flipped = [...id.slice(10)].reverse().join("");
      (event as Record<string, unknown>).id = id.slice(0, 10) + flipped;
    }

    await sendEvents(ctx, events);

    const rows = await getMessages(ctx, destination);
    expect(destinationOrder(rows)).toEqual(sourceOrder);
  });

  test("a same-millisecond burst shares one sort-key time, so the order is lost", async () => {
    // The resolution limit the fix is built around: `sort_idx` is minted from
    // a message's canonical time in MILLISECONDS, so a burst with one shared
    // timestamp has nothing to order it by — every row's sort key carries the
    // same time and the page falls back to the id tie-break. That is why the
    // client stamps each forward one millisecond apart rather than relying on
    // the mint order.
    const ctx = await startAppserver();
    const { source, destination, sourceOrder } = await fixture(ctx, 5);

    const shared = Date.now();
    const events = forwardBurst(source, destination, sourceOrder, shared).map(
      (event) => {
        const extensions = { ...(event.extensions as Record<string, unknown>) };
        // One canonical time for the whole burst.
        extensions["space.roomy.extension.timestampOverride.v0"] = {
          $type: "space.roomy.extension.timestampOverride.v0",
          timestamp: shared,
        };
        return { ...event, extensions };
      },
    );
    await sendEvents(ctx, events);

    const rows = await getMessages(ctx, destination);
    const keyTimes = rows.map((r) => decodeTime(r.sort_idx!));
    expect(keyTimes).toHaveLength(sourceOrder.length);
    // Every sort key resolves to the same millisecond: the page order past
    // this point is the id tie-break, not the source timeline.
    expect(new Set(keyTimes).size).toBe(1);
  });
});
