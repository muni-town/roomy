/**
 * The rendered `<head>` — asserted on the artifact, not the component.
 *
 * `src/lib/server-rendered-meta.test.ts` proves the routes exist and name the
 * right NSIDs; it cannot prove the tags reach the document. A `<svelte:head>`
 * that never renders, or one the client overwrites after hydration, is a
 * component that looks right and a link that unfurls as "Roomy" — which is
 * exactly how the room route lost its server title once already.
 *
 * So this spec fetches the route with no JavaScript at all (`request`, not
 * `page`) and reads the `</head>` the server sent.
 */

import { test, expect } from "@playwright/test";
import {
  APP_LITE_ORIGIN,
  SEED_PUBLIC_ROOM_ID,
  SEED_PUBLIC_ROOM_NAME,
  SEED_PUBLIC_SPACE_AVATAR,
  SEED_PUBLIC_SPACE_ID,
  SEED_PUBLIC_SPACE_NAME,
  SEED_ROOM_ID,
  SEED_SPACE_ID,
  SEED_SPACE_NAME,
  TEST_USER_DID,
  TEST_USER_DISPLAY_NAME,
  TEST_USER_HANDLE,
} from "./fixtures.ts";

/** The `<head>` of a document, before any script has run. */
function head(html: string): string {
  const end = html.indexOf("</head>");
  return end === -1 ? html : html.slice(0, end);
}

/**
 * Where `resolveBlobUrl` serves a space avatar: an `atblob://` reference is not
 * an image URL, so the tag must carry the mapped one.
 */
const PUBLIC_SPACE_AVATAR_URL = SEED_PUBLIC_SPACE_AVATAR.replace(
  "atblob://",
  "https://cdn.bsky.app/img/feed_fullsize/plain/",
);

test.describe("server-rendered space metadata", () => {
  test("a public space's URL names it and images its avatar", async ({ request }) => {
    const res = await request.get(`${APP_LITE_ORIGIN}/${SEED_PUBLIC_SPACE_ID}`);
    expect(res.status()).toBe(200);
    const tags = head(await res.text());

    expect(tags).toContain(`<title>${SEED_PUBLIC_SPACE_NAME} - Roomy</title>`);
    expect(tags).toContain(
      `property="og:title" content="${SEED_PUBLIC_SPACE_NAME} - Roomy"`,
    );
    expect(tags).toContain(`property="og:image" content="${PUBLIC_SPACE_AVATAR_URL}"`);
  });

  test("a room in a public space names the room and the space it belongs to", async ({
    request,
  }) => {
    const res = await request.get(
      `${APP_LITE_ORIGIN}/${SEED_PUBLIC_SPACE_ID}/${SEED_PUBLIC_ROOM_ID}`,
    );
    expect(res.status()).toBe(200);
    const tags = head(await res.text());

    expect(tags).toContain(
      `<title>${SEED_PUBLIC_ROOM_NAME} - ${SEED_PUBLIC_SPACE_NAME}</title>`,
    );
    expect(tags).toContain(
      `property="og:title" content="${SEED_PUBLIC_ROOM_NAME} - ${SEED_PUBLIC_SPACE_NAME}"`,
    );
    expect(tags).toContain(`property="og:image" content="${PUBLIC_SPACE_AVATAR_URL}"`);
  });

  test("an invite-only space's room falls back to the space, not the room", async ({
    request,
  }) => {
    // The appserver refuses an anonymous read of a room in an invite-only space
    // (403), so the room's own tags cannot be built — and the space's name,
    // which `getMetadata` answers for an unjoined caller by design, still can.
    const res = await request.get(`${APP_LITE_ORIGIN}/${SEED_SPACE_ID}/${SEED_ROOM_ID}`);
    expect(res.status()).toBe(200);
    const tags = head(await res.text());

    expect(tags).toContain(`<title>${SEED_SPACE_NAME} - Roomy</title>`);
    expect(tags).not.toContain("lobby");
    expect(tags).toContain(
      `property="og:image" content="https://roomy.space/roomy-og.png"`,
    );
  });

  test("an unknown space falls back to the site defaults and still serves", async ({
    request,
  }) => {
    const res = await request.get(`${APP_LITE_ORIGIN}/did:plc:e2enospace00000000000000`);
    expect(res.status()).toBe(200);
    expect(head(await res.text())).toContain("<title>Roomy</title>");
  });
});

test.describe("server-rendered profile and invite metadata", () => {
  test("a profile URL names the account", async ({ request }) => {
    const res = await request.get(`${APP_LITE_ORIGIN}/user/${TEST_USER_DID}`);
    expect(res.status()).toBe(200);
    const tags = head(await res.text());

    expect(tags).toContain(
      `<title>${TEST_USER_DISPLAY_NAME} (@${TEST_USER_HANDLE}) - Roomy</title>`,
    );
    expect(tags).toContain('property="og:type" content="profile"');
  });

  test("an invite link names the space it invites you to", async ({ request }) => {
    const res = await request.get(
      `${APP_LITE_ORIGIN}/join?space=${SEED_PUBLIC_SPACE_ID}`,
    );
    expect(res.status()).toBe(200);
    const tags = head(await res.text());

    expect(tags).toContain(`<title>${SEED_PUBLIC_SPACE_NAME} - Roomy</title>`);
    expect(tags).toContain(`property="og:image" content="${PUBLIC_SPACE_AVATAR_URL}"`);
  });
});
