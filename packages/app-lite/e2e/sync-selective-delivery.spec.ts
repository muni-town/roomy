/**
 * The sync layer must not refetch the room you are viewing when another room
 * changes.
 *
 * Reported symptom: the UI froze after deleting a message, even after the
 * invalidation-storm fixes. The surviving amplifier was the client's seq-gap
 * detector. Diff frames carried a process-global seq while delivery is
 * selective — a connection receives diffs only for the rooms it is subscribed
 * to — so the seqs it observed were a sparse subsequence and EVERY frame read
 * as "I missed frames", refetching the visible room. Deleting a message in a
 * room with other activity (or any traffic in any other room) therefore
 * produced a refetch per frame.
 *
 * This spec defends the observable contract at the browser: with a room open,
 * activity in a DIFFERENT room must not trigger repeated refetches of the open
 * room's messages. `#invalidate` frames for `room.getMessages` are the tell —
 * they are emitted only by that gap detector (and by a fresh room
 * subscription), so counting them isolates this path.
 */

import { expect, test, waitForAuthenticated, composer } from "./spec-helpers.ts";
import { newUlid } from "@roomy-space/sdk";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_2_ID,
  SEED_ROOM_ID,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  TEST_USER_DID,
} from "./fixtures.ts";

/** POST one batch of events through the real write path, as the test user. */
async function sendEvents(events: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < events.length; i += 50) {
    const resp = await fetch(`${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Did": TEST_USER_DID,
      },
      body: JSON.stringify({ spaceId: SEED_SPACE_ID, events: events.slice(i, i + 50) }),
    });
    if (!resp.ok) {
      throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
    }
  }
}

/** A createMessage event with a unique ULID and body. */
function createMessage(roomId: string, text: string): Record<string, unknown> {
  const body = Buffer.from(new TextEncoder().encode(text)).toString("base64");
  return {
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: { mimeType: "text/plain", data: { $bytes: body } },
    extensions: {},
  };
}

test.describe("sync: selective delivery does not refetch the visible room", () => {
  test("activity in another room does not refetch the open room's messages", async ({
    page,
  }) => {
    // Give the viewed room a body of messages so it is a realistic room.
    await sendEvents(
      Array.from({ length: 20 }, (_, i) =>
        createMessage(SEED_ROOM_ID, `sync-room ${i} ${newUlid()}`),
      ),
    );

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);
    await expect(composer(page)).toBeVisible();

    // The gap detector's observable effect is an HTTP refetch of the open
    // room's messages, so count those requests — a frame that trips the
    // detector does not itself appear as anything else.
    const getMessagesRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("space.roomy.room.getMessages")) {
        getMessagesRequests.push(req.url());
      }
    });

    // Let the initial mount + room-topic subscription settle (the subscribe
    // path invalidates room queries once by design).
    await page.waitForTimeout(3000);
    const before = getMessagesRequests.length;

    // 20 messages in a room the page is NOT viewing (the space's second
    // channel, seeded alongside this one).
    for (let i = 0; i < 20; i++) {
      await sendEvents([createMessage(SEED_ROOM_2_ID, `elsewhere ${i} ${newUlid()}`)]);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(5000);

    const refetches = getMessagesRequests.length - before;

    // THE REGRESSION: with a process-global seq this was one refetch per
    // frame (~20 here), each cancelling and restarting the open room's
    // getMessages query. The bound allows one — a genuine resync may
    // legitimately refetch.
    expect(refetches).toBeLessThanOrEqual(1);

    // The page is still live and the composer still works.
    await expect(composer(page)).toBeVisible();
  });
});
