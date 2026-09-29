/**
 * A badge whose summary query has already failed must not re-ask it.
 *
 * Defends the production symptom: an internal link to a space the appserver
 * holds no materialised row for 404s deterministically (`getSpaceSummary
 * failed: Space not found: …`), and the badge for it sits in a message row of
 * the virtualized list — so every row recycle, and every re-entry into the
 * room, remounted the badge and re-asked a query that can never succeed.
 *
 * `retry: false` alone does not stop that. TanStack's `shouldLoadOnMount`
 * re-issues the fetch for an errored, data-less query unless `retryOnMount` is
 * false, and the link-summary prefetch re-issues it for the same reason
 * (`ensureQueryData` fetches whenever the cached data is `undefined`, which is
 * exactly what a failed fetch leaves behind).
 *
 * The observable contract is request count: for one doomed link target the
 * session issues exactly one `getSpaceSummary` / `getRoomSummary` pair — the
 * first, which 404s — however often the badge remounts, and the badge stays on
 * screen with its fallback label instead of disappearing.
 *
 * Navigation here is client-side (sidebar link clicks), not `page.goto`: the
 * in-memory query cache — and therefore the errored entry — only survives a
 * same-document navigation. A reload is a fresh session, which is the bound
 * the guard is written against ("asked at most once per session").
 *
 * The fixture is a richtext message carrying a `#roomRef` facet that names a
 * valid but unmaterialised (DID, ULID) pair, written through the real
 * `sendEvents` path so the render path under test is the product one.
 */

import type { Page } from "@playwright/test";
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { newUlid, serializeBlocks } from "@roomy-space/sdk";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_2_MESSAGE_TEXT,
  SEED_ROOM_2_PATH,
  SEED_ROOM_ID,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  TEST_USER_DID,
} from "./fixtures.ts";

/**
 * A space that resolves in PLC but has no materialised row in this appserver —
 * the "deterministic 404" shape the guard exists for. Valid DID, never seeded.
 */
const ABSENT_SPACE_ID = "did:plc:e2eabsent0000000000000000";
/** Valid ULID, never materialised, so `getRoomSummary` 404s alongside it. */
const ABSENT_ROOM_ID = "01M3FPE5JXZN84WG1AMBPW3951";
const ABSENT_LINK_PATH = `/${ABSENT_SPACE_ID}/${ABSENT_ROOM_ID}`;
/** The facet's text, which becomes the badge's label. */
const LINK_TEXT = "stale link";

const SPACE_SUMMARY = "space.roomy.space.getSpaceSummary";
const ROOM_SUMMARY = "space.roomy.room.getRoomSummary";

/** POST one event batch through the real write path, as the test user. */
async function sendEvents(events: Record<string, unknown>[]): Promise<void> {
  const resp = await fetch(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Did": TEST_USER_DID,
      },
      body: JSON.stringify({ spaceId: SEED_SPACE_ID, events }),
    },
  );
  if (!resp.ok) {
    throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
  }
}

/**
 * Write a richtext message whose text is one `#roomRef` facet pointing at the
 * absent (space, room) pair. BlocksRenderer turns that facet into an internal
 * anchor, which `enrichInternalLinks` upgrades to a {@link SpaceRoomBadge}.
 */
async function seedAbsentLinkMessage(): Promise<void> {
  const serialized = serializeBlocks([
    {
      $type: "space.roomy.richtext.blocks#text",
      text: LINK_TEXT,
      facets: [
        {
          index: { byteStart: 0, byteEnd: LINK_TEXT.length },
          features: [
            {
              $type: "space.roomy.richtext.facet#roomRef",
              spaceId: ABSENT_SPACE_ID,
              roomId: ABSENT_ROOM_ID,
            },
          ],
        },
      ],
    },
  ]);
  await sendEvents([
    {
      id: newUlid(),
      room: SEED_ROOM_ID,
      $type: "space.roomy.message.createMessage.v0",
      body: {
        mimeType: serialized.mimeType,
        data: { $bytes: Buffer.from(serialized.data).toString("base64") },
      },
      extensions: {},
    },
  ]);
}

/**
 * Requests and responses the guard is meant to bound, split by NSID.
 *
 * Both are recorded, and both listeners are installed before the first
 * navigation: `page.waitForResponse` only sees responses that arrive after it
 * is called, and the pair under test resolves during the initial load.
 *
 * The target is identified by the parsed query param, not a substring of the
 * URL: the space DID is percent-encoded on the wire (`did%3Aplc%3A…`).
 */
function watchSummaryTraffic(page: Page) {
  const requests = { space: [] as string[], room: [] as string[] };
  const responses = { space: 0, room: 0 };
  const classify = (url: string): "space" | "room" | null => {
    if (!url.includes("/xrpc/")) return null;
    const parsed = new URL(url);
    if (
      parsed.pathname.endsWith(SPACE_SUMMARY) &&
      parsed.searchParams.get("spaceId") === ABSENT_SPACE_ID
    ) {
      return "space";
    }
    if (
      parsed.pathname.endsWith(ROOM_SUMMARY) &&
      parsed.searchParams.get("roomId") === ABSENT_ROOM_ID
    ) {
      return "room";
    }
    return null;
  };
  page.on("request", (req) => {
    const kind = classify(req.url());
    if (kind) requests[kind].push(req.url());
  });
  page.on("response", (res) => {
    const kind = classify(res.url());
    if (kind) responses[kind] += 1;
  });
  return { requests, responses };
}

test.describe("a badge for an unmaterialised space does not re-ask an impossible summary", () => {
  test("remounting the badge issues no second summary request", async ({
    page,
  }) => {
    await seedAbsentLinkMessage();

    // Listeners are installed before the first navigation; see
    // `watchSummaryTraffic` for why.
    const traffic = watchSummaryTraffic(page);

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // The badge is the upgraded anchor. Its label is the explicit link text,
    // and it renders from the fallback (the spaceId / roomId) because the
    // summary never resolves — so its presence also proves the failed lookup
    // did not take the row down with it.
    // `.first()`: a retried run re-seeds the same fixture into the same
    // appserver, and every copy dedupes to one cache key anyway.
    const badge = page.locator(`a[href="${ABSENT_LINK_PATH}"]`).first();
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(LINK_TEXT);

    // Wait for the first pair to actually settle before measuring: until the
    // error is cached there is nothing for the guard to skip, so counting
    // before it settles would be measuring the load, not the guard.
    await expect
      .poll(() => traffic.responses.space, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => traffic.responses.room, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(traffic.requests.space).toHaveLength(1);
    expect(traffic.requests.room).toHaveLength(1);

    // Leave the room and come back, three times. Each re-entry remounts the
    // badge (the message row is recreated from the timeline) and re-runs the
    // per-room summary prefetch, so this is the remount loop the production
    // logs counted as one 404 pair per recycle.
    for (let i = 0; i < 3; i++) {
      await page
        .locator(`.sidebar-body-wrap a[href="${SEED_ROOM_2_PATH}"]`)
        .first()
        .click();
      // Wait for the destination room's own message, so the remount of the
      // badge's row is what the next step measures, not a pending navigation.
      await expect(page.locator("ol")).toContainText(SEED_ROOM_2_MESSAGE_TEXT);

      await page
        .locator(`.sidebar-body-wrap a[href="${SEED_ROOM_PATH}"]`)
        .first()
        .click();
      await expect(badge).toBeVisible();
    }

    // Let any re-issued request reach the network before asserting.
    await page.waitForTimeout(1000);

    // THE REGRESSION: without `retryOnMount: false` on the badge queries and
    // the errored-key guard in the prefetcher, each of the three re-entries
    // adds a pair here.
    expect(traffic.requests.space).toHaveLength(1);
    expect(traffic.requests.room).toHaveLength(1);

    // The message (and its badge) is still on screen after the churn.
    await expect(page.locator("ol")).toContainText(LINK_TEXT);
  });
});
