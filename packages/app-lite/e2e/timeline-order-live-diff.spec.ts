/**
 * A live `#messageDiff` must not re-order the room it lands in.
 *
 * `room.getMessages` selects its page by `coalesce(sort_idx, id)`, but a
 * message's `sort_idx` is not its `timestamp`: a move rewrites the sort key to
 * the move event's time so the message appears at the top of the destination,
 * and a bridged backfill keys on the original send time while arriving later.
 * The client merges a diff into the cached list and re-sorts, so if that
 * re-sort keys on `timestamp` instead of `sort_idx` it puts the row somewhere
 * the next page from the server will not — the live view and the page
 * disagree until a reload replaces the cache wholesale.
 *
 * This spec samples the rendered order every 50 ms across the change, so a
 * wrong order that is corrected moments later cannot hide behind a polling
 * assertion that would have retried past it.
 */

import { expect, test, waitForAuthenticated, composer } from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import { newUlid } from "@roomy-space/sdk";
import { APPSERVER_HTTP_ORIGIN, SEED_SPACE_ID, TEST_USER_DID } from "./fixtures.ts";

const DAY = 86_400_000;
const BASE = Date.UTC(2024, 0, 1);

async function sendEvents(events: Record<string, unknown>[]): Promise<void> {
  const resp = await fetch(`${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Did": TEST_USER_DID },
    body: JSON.stringify({ spaceId: SEED_SPACE_ID, events }),
  });
  if (!resp.ok) throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
}

function createRoom(name: string): Record<string, unknown> {
  return { id: newUlid(), $type: "space.roomy.room.createRoom.v0", kind: "space.roomy.channel", name };
}

function createMessageAt(roomId: string, text: string, timestamp: number, override = true) {
  const body = Buffer.from(new TextEncoder().encode(text)).toString("base64");
  return {
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: { mimeType: "text/plain", data: { $bytes: body } },
    extensions: override
      ? {
          "space.roomy.extension.timestampOverride.v0": {
            $type: "space.roomy.extension.timestampOverride.v0",
            timestamp,
          },
        }
      : {},
  };
}

/** Poll until `ol` renders exactly `expected`, then resolve. */
async function waitForOrder(page: Page, expected: string[]): Promise<void> {
  const want = expected.map((_, i) => i).join(",");
  await expect.poll(() => sampleOnce(page, expected), { timeout: 15_000 }).toBe(want);
}

/** One sample of the rendered order. */
async function sampleOnce(page: Page, expected: string[]): Promise<string> {
  return page.evaluate((texts: string[]) => {
    const ol = document.querySelector("ol");
    if (!ol) return "no-ol";
    const text = (ol as HTMLElement).innerText;
    return texts
      .map((t, i) => ({ i, at: text.indexOf(t) }))
      .filter((e) => e.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((e) => e.i)
      .join(",");
  }, expected);
}

/**
 * Sample the room's `ol` text every 50 ms for `ms`, returning the distinct
 * states it passed through.
 *
 * Sampling starts once every expected message is rendered — the rows already
 * in the room while the move is in flight are one state, and asserting on them
 * would be asserting the pre-move render, not the diff's effect. Waiting on
 * presence rather than on the expected order keeps that wait from deciding the
 * test: the order the diff produced is what is asserted, and it is asserted on
 * every sample from here on.
 *
 * Every state is recorded, including ones that heal: a wrong order the diff
 * produced and a later writer repaired still appears in the returned sequence.
 */
async function sampleOrder(page: Page, expected: string[], ms: number): Promise<string[]> {
  // `sampleOnce` drops rows it cannot find, so a complete sample has every
  // index exactly once — the moved row included.
  const complete = expected.map((_, i) => i).join(",");
  await expect
    .poll(() => sampleOnce(page, expected), { timeout: 15_000 })
    .toBe(complete);
  const seen: string[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const order = await sampleOnce(page, expected);
    const last = seen[seen.length - 1];
    if (order !== last) seen.push(order);
    await page.waitForTimeout(50);
  }
  return seen;
}

test.describe("a live diff keeps the room in the server's order", () => {
  test("a message moved into the open room lands where the server keys it", async ({ page }) => {
    const run = newUlid();
    const destTexts = Array.from({ length: 5 }, (_, i) => `order dest ${i} ${run}`);
    const destRoom = createRoom(`order-dest-${run}`);
    await sendEvents([destRoom]);
    const destRoomId = destRoom.id as string;
    await sendEvents(destTexts.map((t, i) => createMessageAt(destRoomId, t, BASE + i * DAY)));

    const movedText = `order moved ${run}`;
    const srcRoom = createRoom(`order-src-${run}`);
    await sendEvents([srcRoom]);
    const srcRoomId = srcRoom.id as string;
    await sendEvents([createMessageAt(srcRoomId, movedText, BASE - 30 * DAY)]);
    const list = await fetch(
      `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.room.getMessages?roomId=${encodeURIComponent(srcRoomId)}&limit=50`,
      { headers: { "X-Test-Did": TEST_USER_DID } },
    );
    const { messages } = (await list.json()) as { messages: Array<{ id: string }> };
    const movedId = messages[messages.length - 1]!.id;

    await page.goto(`/${SEED_SPACE_ID}/${destRoomId}`);
    await waitForAuthenticated(page);
    await expect(composer(page)).toBeVisible();
    await waitForOrder(page, destTexts);
    // Make the WS patch the only writer for a moment. The room's `getMessages`
    // query is invalidated by the move, and that refetch would put the cache
    // right by itself — so hold the read path shut while the diff lands and
    // the order is sampled. What is asserted is therefore the order the diff
    // produced, not the order a subsequent fetch repaired.
    let stalled = false;
    await page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
      if (stalled && route.request().url().includes("room.getMessages")) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 30_000);
        await promise;
        return route.continue();
      }
      return route.continue({ headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID } });
    });
    stalled = true;

    await sendEvents([
      {
        id: newUlid(),
        room: srcRoomId,
        $type: "space.roomy.message.moveMessages.v0",
        messageIds: [movedId],
        toRoomId: destRoomId,
      },
    ]);

    // The moved row is keyed at the move time, so the server pages it newest
    // — last in this oldest-first view. It must never render anywhere else.
    const all = [...destTexts, movedText];
    const states = await sampleOrder(page, all, 4000);
    expect(states).toEqual(["0,1,2,3,4,5"]);
  });
});
