/**
 * Client-side block redaction.
 *
 * The server's tombstone is the guarantee; this pass closes the window
 * `staleTime: Infinity` opens, where a row cached *before* a block keeps its
 * body until the next diff or refetch. These tests pin the three shapes the
 * pass has to produce — the tombstone, the untouched row, and the adopted
 * reveal — and the two-author case a forward is.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the
 * file runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedTombstone, redactBlockedAuthors } from "./redact.ts";
import type { Message } from "$lib/queries/messages";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CAROL = "did:plc:carol";

const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

let seq = 0;
function message(overrides: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `01MESSAGE${String(seq).padStart(8, "0")}`,
    sort_idx: `01SORT${String(seq).padStart(11, "0")}`,
    content: "hello",
    mimeType: "text/markdown",
    authorDid: ALICE,
    authorName: "Alice",
    timestamp: at(0),
    reactions: [],
    attachments: [],
    media: [],
    linkEmbeds: [],
    ...overrides,
  };
}

/** A forward of `original` by `forwarder`. */
function forward(forwarder: string, original: Message): Message {
  return message({
    authorDid: forwarder,
    authorName: "Forwarder",
    forwardedFrom: {
      messageId: original.id,
      roomId: "01ROOM0000000000000000000",
      name: "general",
      message: original,
    },
  });
}

const NONE: ReadonlySet<string> = new Set();

describe("redactBlockedAuthors", () => {
  test("a row by a blocked author becomes the server's tombstone", () => {
    const row = message({
      authorDid: BOB,
      authorName: "Bob",
      content: "a body the viewer must not read",
      authorHandle: "bob.bsky.social",
      authorAvatar: "https://cdn.example/bob.png",
      lastEdit: "01EDIT000000000000000000",
      replyTo: "01PARENT0000000000000000",
      reactions: [{ emoji: "👍", count: 2 }],
      media: [{ url: "https://cdn.example/a.png", type: "image/png" }],
      linkEmbeds: [{ url: "https://example.com" }],
    });

    const [out] = redactBlockedAuthors([row], new Set([BOB]), NONE);

    assert.ok(out);
    assert.equal(out.blocked, true);
    assert.equal(out.content, "");
    assert.equal(out.authorName, "");
    assert.equal(out.authorHandle, undefined);
    assert.equal(out.authorAvatar, undefined);
    assert.equal(out.lastEdit, undefined);
    assert.equal(out.replyTo, undefined);
    assert.equal(out.mimeType, undefined);
    assert.deepEqual(out.reactions, []);
    assert.deepEqual(out.media, []);
    assert.deepEqual(out.linkEmbeds, []);
    // Ordering and deep links survive: the row keeps its place in the page.
    assert.equal(out.id, row.id);
    assert.equal(out.sort_idx, row.sort_idx);
    assert.equal(out.timestamp, row.timestamp);
    assert.equal(out.authorDid, BOB);
    // And the shape is exactly what the server sends, so the client can tell
    // it apart from a message whose body is genuinely empty.
    assert.equal(isBlockedTombstone(out), true);
  });

  test("a row by an author the viewer has not blocked is untouched", () => {
    const row = message({ authorDid: CAROL, authorName: "Carol" });
    const [out] = redactBlockedAuthors([row], new Set([BOB]), NONE);
    assert.equal(out, row);
  });

  test("a forward of a blocked author's message redacts the embedded original", () => {
    const original = message({
      authorDid: BOB,
      authorName: "Bob",
      content: "the original words",
    });
    const row = forward(ALICE, original);

    const [out] = redactBlockedAuthors([row], new Set([BOB]), NONE);

    assert.ok(out);
    // The forwarder's own row is intact: they are not blocked.
    assert.equal(out.blocked, undefined);
    assert.equal(out.authorDid, ALICE);
    const embedded = out.forwardedFrom?.message;
    assert.ok(embedded);
    assert.equal(embedded.blocked, true);
    assert.equal(embedded.content, "");
    assert.equal(embedded.authorName, "");
    assert.equal(isBlockedTombstone(embedded), true);
    // A blocked author's words do not survive by being forwarded by someone
    // else, and the forward's own compat fields are preserved.
    assert.equal(out.forwardedFrom?.messageId, original.id);
  });

  test("a forward whose forwarder is blocked is redacted wholesale", () => {
    const row = forward(BOB, message({ authorDid: CAROL, authorName: "Carol" }));
    const [out] = redactBlockedAuthors([row], new Set([BOB]), NONE);

    assert.ok(out);
    assert.equal(out.blocked, true);
    assert.equal(out.content, "");
    assert.equal(out.forwardedFrom, undefined);
    assert.equal(isBlockedTombstone(out), true);
  });

  test("a row fetched as a reveal is adopted wholesale, embedded original included", () => {
    const original = message({ authorDid: BOB, authorName: "Bob" });
    const row = forward(ALICE, original);
    // The server widened this one fetch for an admin who placed the block:
    // the row is a full body that still says `blocked`.
    const revealed = { ...row, blocked: true };

    const [out] = redactBlockedAuthors(
      [revealed],
      new Set([BOB]),
      new Set([revealed.id]),
    );

    // Neither the row nor its embedded original is redacted again.
    assert.equal(out, revealed);
    assert.equal(out.forwardedFrom?.message, original);
  });
});
