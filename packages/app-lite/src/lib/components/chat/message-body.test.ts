/**
 * Whether a message body renders anything visible.
 *
 * The regression this defends: a forward with no commentary renders an empty
 * bubble below the forwarded message, because the forwarder's body is a
 * blocks+facets document whose base64 encoding is a non-empty string even
 * when it holds no content. Testing `content` for truthiness therefore says
 * "yes" for a bare forward; the predicate must decode the body instead.
 *
 * The empty-document shapes are the real ones the client produces: an
 * untouched Tiptap composer serializes a single `#text` block with `text: ""`
 * (see `ChatInput.getBlocks`), and thread creation forwards with
 * `serializeBlocks([])`. Both are encoded here exactly as the wire would
 * carry them, so the test fails if the predicate ever regresses to a
 * string-truthiness check.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the
 * file runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RICHTEXT_MIME, serializeBlocks } from "@roomy-space/sdk";
import { messageHasVisibleContent, parseRichTextContent } from "./message-body.ts";

/** The wire `content` for a rich-text body: base64 of the encoded document. */
function wire(content: string): string {
  return Buffer.from(content).toString("base64");
}

/** What an untouched composer serializes to (`ChatInput.getBlocks`). */
const UNTOUCHED_COMPOSER_DOC = {
  $type: "space.roomy.richtext.document",
  blocks: [{ $type: "space.roomy.richtext.blocks#text", text: "" }],
};

describe("messageHasVisibleContent — rich text", () => {
  test("an untouched composer's empty text block is not visible", () => {
    const content = wire(JSON.stringify(UNTOUCHED_COMPOSER_DOC));
    // The body is non-empty as a string — which is what made the forwarder's
    // commentary bubble render on a bare forward.
    assert.notEqual(content, "");
    assert.equal(messageHasVisibleContent(content, RICHTEXT_MIME), false);
  });

  test("a thread forward's empty blocks document is not visible", () => {
    const serialized = serializeBlocks([]);
    const content = wire(new TextDecoder().decode(serialized.data));
    assert.equal(messageHasVisibleContent(content, RICHTEXT_MIME), false);
  });

  test("a whitespace-only text block is not visible", () => {
    const content = wire(
      JSON.stringify({
        $type: "space.roomy.richtext.document",
        blocks: [{ $type: "space.roomy.richtext.blocks#text", text: "   \n " }],
      }),
    );
    assert.equal(messageHasVisibleContent(content, RICHTEXT_MIME), false);
  });

  test("real commentary is visible", () => {
    const content = wire(
      JSON.stringify({
        $type: "space.roomy.richtext.document",
        blocks: [
          { $type: "space.roomy.richtext.blocks#text", text: "my take on this" },
        ],
      }),
    );
    assert.equal(messageHasVisibleContent(content, RICHTEXT_MIME), true);
  });

  test("a non-text block that renders an element counts", () => {
    // BlocksRenderer emits an <img> / <hr> for these even with no text, so a
    // caption-less image forward is not a bare forward.
    for (const block of [
      { $type: "space.roomy.richtext.blocks#image", uri: "https://x/y.png" },
      { $type: "space.roomy.richtext.blocks#horizontalRule" },
    ]) {
      const content = wire(
        JSON.stringify({ $type: "space.roomy.richtext.document", blocks: [block] }),
      );
      assert.equal(messageHasVisibleContent(content, RICHTEXT_MIME), true);
    }
  });

  test("a malformed rich-text body is not visible and does not throw", () => {
    assert.equal(messageHasVisibleContent("not-valid-base64-json!!", RICHTEXT_MIME), false);
    assert.equal(messageHasVisibleContent("", RICHTEXT_MIME), false);
  });
});

describe("messageHasVisibleContent — legacy markdown", () => {
  test("blank and whitespace-only bodies are not visible", () => {
    assert.equal(messageHasVisibleContent("", undefined), false);
    assert.equal(messageHasVisibleContent("   \n\t ", "text/markdown"), false);
  });

  test("text is visible", () => {
    assert.equal(messageHasVisibleContent("hello", "text/markdown"), true);
  });
});

describe("parseRichTextContent", () => {
  test("round-trips an empty document to an empty block list", () => {
    const serialized = serializeBlocks([]);
    const content = wire(new TextDecoder().decode(serialized.data));
    assert.deepEqual(parseRichTextContent(content), []);
  });

  test("returns null for a legacy markdown body", () => {
    assert.equal(parseRichTextContent(wire(JSON.stringify({ not: "a doc" }))), null);
  });
});
