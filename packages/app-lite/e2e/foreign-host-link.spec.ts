/**
 * A link to someone else's site whose path happens to contain a DID must not
 * be treated as a Roomy space reference.
 *
 * `https://twinkl.social/did:plc:…` is a page on twinkl.social; the DID is a
 * segment that site chose. The converters used to read only the *path*, so
 * writing that link into a message emitted a `#roomRef` facet for it — and
 * every reader's badge prefetch then asked this appserver for the summary of
 * a space that cannot exist, forever (the same DID, day after day, from the
 * room the link was posted in).
 *
 * The observable contract is on the write side: a message body carrying that
 * link holds a `#link` facet and no `#roomRef` facet, and opening the room
 * issues no summary request for the DID. A link to an origin this deployment
 * serves still produces the facet and still becomes a badge, so the badge
 * path itself is unchanged.
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { newUlid } from "@roomy-space/sdk";
import {
  APP_LITE_ORIGIN,
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_ID,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  TEST_USER_DID,
} from "./fixtures.ts";

/** A DID that resolves in PLC but is not a space this appserver materialises. */
const FOREIGN_DID = "did:plc:rqbqpaaluty5v47jwciowpik";
/** The exact shape that produced the production 404s. */
const FOREIGN_URL = `https://twinkl.social/${FOREIGN_DID}`;
/**
 * A second space DID, referenced through this deployment's own origin. It is
 * equally absent from this appserver (so its badge 404s too, which is the
 * badge path working as designed), and it is a *different* DID so the control
 * link cannot be confused with the one under test.
 */
const ROOMY_DID = "did:plc:cyqufxsezk33hqulcilckna6";
const ROOMY_URL = `${APP_LITE_ORIGIN}/${ROOMY_DID}`;

const SPACE_SUMMARY = "space.roomy.space.getSpaceSummary";

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
 * Write a markdown message naming the foreign-host link.
 *
 * Markdown is one of the two ingest paths (`applyBatch` converts
 * `text/markdown` bodies through the SDK converter); it shares
 * `parseInternalLinkHref` with the composer's ProseMirror path, which the
 * SDK unit tests cover directly.
 */
async function seedForeignHostLinkMessage(): Promise<void> {
  await sendEvents([
    {
      id: newUlid(),
      room: SEED_ROOM_ID,
      $type: "space.roomy.message.createMessage.v0",
      body: {
        mimeType: "text/markdown",
        data: {
          $bytes: Buffer.from(
            `see ${FOREIGN_URL} and ${ROOMY_URL}`,
            "utf8",
          ).toString("base64"),
        },
      },
      extensions: {},
    },
  ]);
}

test.describe("a DID path on a foreign host is an ordinary link", () => {
  test("the message body carries no roomRef for the foreign host, and the room asks for no summary", async ({
    page,
  }) => {
    await seedForeignHostLinkMessage();

    // Every summary request for the DID under test, recorded from before the
    // first navigation (the badge's lookup resolves during the initial load).
    const summaryRequests: string[] = [];
    page.on("request", (req) => {
      if (!req.url().includes("/xrpc/")) return;
      const parsed = new URL(req.url());
      if (
        parsed.pathname.endsWith(SPACE_SUMMARY) &&
        parsed.searchParams.get("spaceId") === FOREIGN_DID
      ) {
        summaryRequests.push(req.url());
      }
    });

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // The foreign-host link renders as a plain anchor to that URL — no badge.
    const link = page.locator(`a[href="${FOREIGN_URL}"]`).first();
    await expect(link).toBeVisible();
    await expect(link).not.toHaveAttribute("data-roomy-internal-link", "true");

    // The Roomy-host link is still an internal reference: it is replaced by a
    // badge (href the original absolute URL, label the DID, since the summary
    // does not resolve) — so the badge path is intact and this is not simply
    // "no badges anywhere".
    const badge = page.locator(`a[href="${ROOMY_URL}"]`).first();
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(ROOMY_DID);

    await page.waitForTimeout(1000);
    expect(summaryRequests).toEqual([]);
  });
});
