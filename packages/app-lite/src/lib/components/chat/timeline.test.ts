/**
 * Timeline merge grouping.
 *
 * A forward shows the ORIGINAL author, so grouping it by the FORWARDER's
 * authorDid would let a follow-up message merge into the forward's row and lose
 * its header — the pair reading as two messages by the original author.
 *
 * A forward is therefore a hard merge boundary: it never merges, and nothing
 * merges into it. These tests pin that, plus the ordinary same-author merge
 * rule it must not disturb.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the
 * file runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mergeTimeline } from "./timeline.ts";
import type { Message } from "$lib/queries/messages";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";

const T0 = Date.parse("2026-09-21T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

let seq = 0;
function message(overrides: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `01MESSAGE${String(seq).padStart(8, "0")}`,
    content: "hello",
    authorDid: ALICE,
    authorName: "Alice",
    timestamp: at(0),
    reactions: [],
    media: [],
    linkEmbeds: [],
    ...overrides,
  };
}

/** A forward by `authorDid` of someone else's message. */
function forward(forwarderDid: string, timestamp: string): Message {
  return message({
    authorDid: forwarderDid,
    timestamp,
    forwardedFrom: {
      messageId: "01ORIGINAL000000000000000",
      roomId: "01ROOM0000000000000000000",
      name: "general",
      message: message({ authorDid: BOB, authorName: "Bob" }),
    },
  });
}

describe("mergeTimeline", () => {
  test("an ordinary run by one author merges", () => {
    const merged = mergeTimeline([
      message({ timestamp: at(0) }),
      message({ timestamp: at(1_000) }),
    ]);
    assert.deepEqual(
      merged.map((m) => m.mergeWithPrevious),
      [false, true],
    );
  });

  test("a different author starts a new group", () => {
    const merged = mergeTimeline([
      message({ authorDid: ALICE, timestamp: at(0) }),
      message({ authorDid: BOB, timestamp: at(1_000) }),
    ]);
    assert.deepEqual(
      merged.map((m) => m.mergeWithPrevious),
      [false, false],
    );
  });

  test("a reply starts a new group", () => {
    const merged = mergeTimeline([
      message({ timestamp: at(0) }),
      message({ timestamp: at(1_000), replyTo: "01REPLYY0000000000000000" }),
    ]);
    assert.deepEqual(
      merged.map((m) => m.mergeWithPrevious),
      [false, false],
    );
  });

  test("a message outside the time window starts a new group", () => {
    const merged = mergeTimeline([
      message({ timestamp: at(0) }),
      message({ timestamp: at(5 * 60 * 1000) }),
    ]);
    assert.deepEqual(
      merged.map((m) => m.mergeWithPrevious),
      [false, false],
    );
  });

  // ── Forwards are hard boundaries ──────────────────────────────────────

  test("a forward never merges, even after the forwarder's own message", () => {
    const merged = mergeTimeline([
      message({ authorDid: ALICE, timestamp: at(0) }),
      forward(ALICE, at(1_000)),
    ]);
    assert.equal(merged[1]?.mergeWithPrevious, false);
  });

  test("a message after the forwarder's own forward does not merge into it", () => {
    // Forward by ALICE of BOB's message, then ALICE sends her own message.
    // The forward displays BOB, so ALICE's message must keep its own header —
    // otherwise both rows read as BOB's.
    const merged = mergeTimeline([
      forward(ALICE, at(0)),
      message({ authorDid: ALICE, timestamp: at(1_000) }),
    ]);
    assert.equal(merged[0]?.mergeWithPrevious, false);
    assert.equal(merged[1]?.mergeWithPrevious, false);
  });

  test("a forward between two of the forwarder's messages splits the run", () => {
    const merged = mergeTimeline([
      message({ authorDid: ALICE, timestamp: at(0) }),
      forward(ALICE, at(1_000)),
      message({ authorDid: ALICE, timestamp: at(2_000) }),
    ]);
    assert.deepEqual(
      merged.map((m) => m.mergeWithPrevious),
      [false, false, false],
    );
  });

  test("input order is preserved and every row is flagged", () => {
    const input = [
      message({ timestamp: at(0) }),
      message({ timestamp: at(1_000) }),
      forward(BOB, at(2_000)),
    ];
    const merged = mergeTimeline(input);
    assert.deepEqual(
      merged.map((m) => m.id),
      input.map((m) => m.id),
    );
    assert.equal(merged.length, 3);
  });

  test("an empty timeline stays empty", () => {
    assert.deepEqual(mergeTimeline([]), []);
  });
});
