/**
 * A response for one room must never be written into another.
 *
 * `roomId` is a live prop: ChatArea survives a channel→channel navigation
 * (the route re-renders it with a new prop instead of remounting), so an async
 * read path that re-reads the prop *after* its `await` addresses whatever room
 * the user is in by then — not the room it asked about. `room.getMessages` is
 * the slow read (production p50 73 ms, spikes to seconds when the per-space
 * worker is backed up), which is exactly the window a user clicking through
 * channels lands in.
 *
 * Two such paths exist:
 *
 *  - the room's first page (`createMessagesQuery`), whose post-await cache
 *    merge re-reads the live prop to choose which cache entry to merge from;
 *  - the older page (`ChatArea.loadOlderMessages`), which re-reads it to
 *    choose the key to write.
 *
 * Both put one room's messages into another room's cache, so messages that
 * were never posted to a channel render in it until something refetches that
 * key.
 *
 * Each test holds the response with Playwright's route interception, leaves
 * the room, and only then releases it — reproducing the ordering a slow
 * appserver produces on its own, deterministically.
 */

import {
  expect,
  installTestAuth,
  messageList,
  test,
  waitForAuthenticated,
} from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import { newUlid } from "@roomy-space/sdk";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  TEST_USER_DID,
} from "./fixtures.ts";

async function sendEvents(events: Record<string, unknown>[]): Promise<void> {
  const resp = await fetch(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Did": TEST_USER_DID },
      body: JSON.stringify({ spaceId: SEED_SPACE_ID, events }),
    },
  );
  if (!resp.ok) {
    throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
  }
}

function createRoom(name: string): Record<string, unknown> {
  return {
    id: newUlid(),
    $type: "space.roomy.room.createRoom.v0",
    kind: "space.roomy.channel",
    name,
  };
}

/**
 * A message stamped at `at` rather than at its arrival time.
 *
 * `sort_idx` for a live `createMessage` is a ULID minted from the server's
 * arrival millisecond plus the ULID's random bits, so every message of a
 * single `sendEvents` burst that lands in one millisecond orders arbitrarily
 * among the others. The second test pages a room whose newest 50 rows are one
 * such burst and asserts the newest is on screen; a random order there is a
 * coin flip, not a failure of the code under test. An explicit
 * `timestampOverride` (the ordering rule the Discord bridge uses) pins each
 * message's key, so "seeded later" means "newer".
 */
function createMessage(
  roomId: string,
  text: string,
  at: number,
): Record<string, unknown> {
  const body = Buffer.from(new TextEncoder().encode(text)).toString("base64");
  return {
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: { mimeType: "text/plain", data: { $bytes: body } },
    extensions: {
      "space.roomy.extension.timestampOverride.v0": {
        $type: "space.roomy.extension.timestampOverride.v0",
        timestamp: at,
      },
    },
  };
}

/**
 * Route interception that holds matching `room.getMessages` requests until
 * they are released, then continues them with the test-auth header the
 * fixture's own route would have added.
 *
 * `hold` selects requests to park; `stallAll` parks every `getMessages` from
 * then on — used to freeze the read path so what renders is the cache the
 * tested write produced, not a later refetch that repaired it.
 */
function getMessagesGate(page: Page) {
  const held: Array<{ url: string; release: () => void }> = [];
  let hold: (url: string) => boolean = () => false;
  let stallAll = false;

  const install = page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
    const url = route.request().url();
    if (url.includes("room.getMessages") && (stallAll || hold(url))) {
      const { promise, resolve } = Promise.withResolvers<void>();
      held.push({ url, release: resolve });
      await promise;
    }
    return route.continue({
      headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID },
    });
  });

  return {
    install,
    hold: (predicate: (url: string) => boolean) => {
      hold = predicate;
    },
    stallAll: (value: boolean) => {
      stallAll = value;
    },
    held,
    releaseAll: () => {
      for (const entry of held.splice(0)) entry.release();
    },
  };
}

function roomLink(page: Page, roomId: string) {
  return page
    .locator(`.sidebar-body-wrap a[href="/${SEED_SPACE_ID}/${roomId}"]`)
    .first();
}

/** Scroll the room's message viewport to its top, as a reader paging back does. */
async function scrollListToTop(page: Page): Promise<void> {
  await page.locator("ol").evaluate((ol) => {
    let el: HTMLElement | null = ol as HTMLElement;
    while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
    if (el) el.scrollTop = 0;
  });
}

/**
 * Load the app once before the first assertion.
 *
 * These tests hold appserver responses, so the cold path — Vite compiling the
 * route, the appserver materialising on its first request, the stub PDS
 * answering the first login — can outlast the shell's own budget. Paying it
 * here keeps the per-test wait about the app rather than about the machine.
 */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await installTestAuth(page);
  await page.goto(SEED_ROOM_PATH);
  await waitForAuthenticated(page, 120_000);
  await page.close();
});

test.describe("a response that outlives its room lands in its own room", () => {
  test("the room's first page is not merged with the room the reader moved to", async ({
    page,
  }) => {
    const run = newUlid();
    const roomA = createRoom(`late-a-${run}`);
    const roomB = createRoom(`late-b-${run}`);
    await sendEvents([roomA, roomB]);
    const aId = roomA.id as string;
    const bId = roomB.id as string;

    const aText = `late a message ${run}`;
    const bText = `late b message ${run}`;
    const at = Date.now();
    await sendEvents([
      createMessage(aId, aText, at),
      createMessage(bId, bText, at),
    ]);

    const gate = getMessagesGate(page);
    gate.hold((url) => url.includes(aId));
    await gate.install;

    await page.goto(`/${SEED_SPACE_ID}/${aId}`);
    await waitForAuthenticated(page);
    // A's first page is in flight, held — the room is empty until it lands.
    await expect.poll(() => gate.held.length).toBeGreaterThan(0);

    // Leave A while its page is still in flight; B loads normally, so B's
    // messages are cached by the time A's response resolves.
    await roomLink(page, bId).click();
    await expect(messageList(page)).toContainText(bText);

    // Release A's page. The response is A's; everything it merges from the
    // cache must be A's too.
    const aResponse = page.waitForResponse(
      (r) => r.url().includes(aId) && r.url().includes("room.getMessages"),
    );
    gate.releaseAll();
    await aResponse;
    await page.waitForTimeout(500);

    // Freeze the read path so returning to A renders the cache the response
    // wrote, rather than a refetch that would repair it first.
    gate.stallAll(true);
    await roomLink(page, aId).click();
    await expect(messageList(page)).toContainText(aText);
    await expect(messageList(page)).not.toContainText(bText);
  });

  test("an older page fetched from a room is not written into the room the reader moved to", async ({
    page,
  }) => {
    const run = newUlid();
    const roomA = createRoom(`older-a-${run}`);
    const roomB = createRoom(`older-b-${run}`);
    await sendEvents([roomA, roomB]);
    const aId = roomA.id as string;
    const bId = roomB.id as string;

    // A's history is two pages: the newest 50 (the first page) and 5 older
    // ones that only a backward page reaches. Explicit stamps keep the two
    // pages disjoint and their rows in seeded order.
    const oldText = (i: number) => `older a old ${i} ${run}`;
    const newText = (i: number) => `older a new ${i} ${run}`;
    const oldAt = Date.now();
    const newAt = oldAt + 1_000;
    await sendEvents(
      Array.from({ length: 5 }, (_, i) => createMessage(aId, oldText(i), oldAt + i)),
    );
    await sendEvents(
      Array.from({ length: 50 }, (_, i) => createMessage(aId, newText(i), newAt + i)),
    );

    const bText = (i: number) => `older b ${i} ${run}`;
    await sendEvents([
      createMessage(bId, bText(0), oldAt),
      createMessage(bId, bText(1), oldAt + 1),
    ]);

    const gate = getMessagesGate(page);
    gate.hold((url) => url.includes(aId) && url.includes("cursor="));
    await gate.install;

    await page.goto(`/${SEED_SPACE_ID}/${aId}`);
    await waitForAuthenticated(page);
    await expect(messageList(page)).toContainText(newText(49));

    // Page backward: the older page is in flight and held.
    await scrollListToTop(page);
    await expect.poll(() => gate.held.length).toBeGreaterThan(0);

    // Read B while A's older page is still outstanding.
    await roomLink(page, bId).click();
    await expect(messageList(page)).toContainText(bText(1));

    // Release A's older page. It belongs to A, so B — the room on screen —
    // must not acquire its rows.
    const olderResponse = page.waitForResponse(
      (r) => r.url().includes(aId) && r.url().includes("cursor="),
    );
    gate.releaseAll();
    await olderResponse;
    await page.waitForTimeout(500);

    // Freeze the read path, then scroll B to the top: the prepended rows, if
    // any, are above the viewport, so this is what puts them in the DOM.
    gate.stallAll(true);
    await scrollListToTop(page);
    await expect(messageList(page)).toContainText(bText(0));
    await expect(messageList(page)).not.toContainText(oldText(0));
  });
});
