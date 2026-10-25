/**
 * The attachment list, split for the renderers.
 *
 * Every surface that draws a message's attachments reads the one
 * `attachments: AttachmentDto[]` through `attachment-views.ts`; these tests pin
 * the third arm — tiles — and that a tile reaches neither of the other two
 * (it is not media, and it is not a link card).
 *
 * Written against `node:test` + `node:assert` (`app-lite` ships no test runner
 * of its own), so the file runs under both `bun test` and
 * `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { linkItems, mediaItems, tileItems } from "./attachment-views.ts";
import type { Message } from "$lib/queries/messages";

const TILE = "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/ing.dasl.masl/3kabc";
const OTHER_TILE = "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/ing.dasl.masl/3kdef";

type Attachments = Message["attachments"];

describe("tileItems", () => {
  test("returns tiles in message order, with the payload each carries", () => {
    const attachments: Attachments = [
      { $type: "space.roomy.attachment.tile.v0", url: TILE, data: { rows: [1, 2] } },
      { $type: "space.roomy.attachment.link.v0", url: "https://example.com" },
      { $type: "space.roomy.attachment.tile.v0", url: OTHER_TILE },
    ];

    assert.deepEqual(tileItems(attachments), [
      { url: TILE, data: { rows: [1, 2] } },
      // A payload the attachment does not carry is absent, not `undefined`.
      { url: OTHER_TILE },
    ]);
  });

  test("a tile is neither media nor a link", () => {
    const attachments: Attachments = [
      { $type: "space.roomy.attachment.tile.v0", url: TILE, data: "x" },
    ];

    assert.deepEqual(tileItems(attachments), [{ url: TILE, data: "x" }]);
    assert.deepEqual(mediaItems(attachments), []);
    assert.deepEqual(linkItems(attachments), []);
  });

  test("leaves the media and link arms unchanged", () => {
    const attachments: Attachments = [
      {
        $type: "space.roomy.attachment.image.v0",
        url: "https://cdn.example.com/a.png",
        type: "image/png",
        alt: "a picture",
      },
      {
        $type: "space.roomy.attachment.link.v0",
        url: "https://example.com",
        embed: { t: "A title" },
      },
      { $type: "space.roomy.attachment.tile.v0", url: TILE },
    ];

    assert.deepEqual(mediaItems(attachments), [
      { url: "https://cdn.example.com/a.png", type: "image/png", alt: "a picture" },
    ]);
    assert.deepEqual(linkItems(attachments), [
      { url: "https://example.com", embed: { t: "A title" } },
    ]);
  });
});
