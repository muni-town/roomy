/**
 * Where a link in a message body opens on the web build.
 *
 * A `#link` facet that leaves this deployment opens in a new tab, so following
 * it does not replace the tab Roomy is running in. A link to an origin this
 * deployment serves stays in the document, the same split the markdown
 * renderer makes. (The native shell routes clicks itself, see
 * `link-routing.ts`; this is the web build's contract.)
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { newUlid, serializeBlocks } from "@roomy-space/sdk";
import {
  APP_LITE_ORIGIN,
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_ID,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  TEST_USER_DID,
} from "./fixtures.ts";

/** An external link on a `.invalid` host (RFC 2606), so nothing enriches it. */
const EXTERNAL_URL = "https://link-target.invalid/page";
/** A link to this deployment's own origin that is not a space/room badge. */
const INTERNAL_URL = `${APP_LITE_ORIGIN}/user/${TEST_USER_DID}`;

/** POST a rich-text message with one `#link` facet per URL, as the test user. */
async function postLinkMessage(): Promise<string> {
  const id = newUlid();
  const external = "external";
  const internal = "internal";
  const text = `${external} ${internal}`;
  const serialized = serializeBlocks([
    {
      $type: "space.roomy.richtext.blocks#text",
      text,
      facets: [
        {
          index: { byteStart: 0, byteEnd: external.length },
          features: [{ $type: "space.roomy.richtext.facet#link", uri: EXTERNAL_URL }],
        },
        {
          index: { byteStart: external.length + 1, byteEnd: text.length },
          features: [{ $type: "space.roomy.richtext.facet#link", uri: INTERNAL_URL }],
        },
      ],
    },
  ]);
  const resp = await fetch(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Did": TEST_USER_DID },
      body: JSON.stringify({
        spaceId: SEED_SPACE_ID,
        events: [
          {
            id,
            room: SEED_ROOM_ID,
            $type: "space.roomy.message.createMessage.v0",
            body: {
              mimeType: serialized.mimeType,
              data: { $bytes: Buffer.from(serialized.data).toString("base64") },
            },
            extensions: {},
          },
        ],
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
  }
  return id;
}

test("an external link in a message opens in a new tab; an internal one does not", async ({
  page,
}) => {
  const messageId = await postLinkMessage();

  await page.goto(SEED_ROOM_PATH);
  await waitForAuthenticated(page);

  const row = page.locator(`[data-message-id="${messageId}"]`);

  const external = row.locator(`a[href="${EXTERNAL_URL}"]`);
  await expect(external).toBeVisible();
  await expect(external).toHaveAttribute("target", "_blank");
  await expect(external).toHaveAttribute("rel", "noopener noreferrer");

  // The body's own anchor, not the link card the appserver may attach for it.
  const internal = row.getByRole("link", { name: "internal", exact: true });
  await expect(internal).toBeVisible();
  await expect(internal).toHaveAttribute("href", INTERNAL_URL);
  await expect(internal).not.toHaveAttribute("target", /.*/);
});
