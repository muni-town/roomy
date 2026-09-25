/**
 * Freshness gate.
 *
 * Cover for the push burst a replay causes: the Discord bridge `runBackfill`
 * ingests historical messages with fresh event ULIDs, and without an age check
 * every replayed message produces a live push.
 *
 * An enqueue site that passes only `decodeTime(event.id)` (always "now") leaves
 * nothing to consult, so the boundary test below is the one that distinguishes
 * a real age check from always-fresh behaviour.
 */

import { describe, expect, test } from "bun:test";
import { ulid } from "ulidx";
import { isPushFresh, PUSH_MAX_MESSAGE_AGE_MS } from "./freshness.ts";

const NOW = 1_800_000_000_000; // fixed clock
const freshId = ulid(NOW - 1_000); // ingested 1s ago
const oldId = ulid(NOW - 6 * 60 * 60 * 1000); // ingested 6h ago

describe("push/freshness — isPushFresh", () => {
  test("live message (canonical time ~now) is fresh", () => {
    expect(isPushFresh({ canonicalTimestamp: NOW - 2_000, messageId: freshId }, NOW)).toBe(true);
  });

  test("historical message replayed now is NOT fresh", () => {
    // A day-old message, ingested this instant. The event ULID is fresh; only
    // the canonical time reveals the message is old.
    const dayOld = NOW - 24 * 60 * 60 * 1000;
    expect(isPushFresh({ canonicalTimestamp: dayOld, messageId: freshId }, NOW)).toBe(false);
  });

  test("boundary: exactly at the window is fresh, one ms past is not", () => {
    expect(isPushFresh({ canonicalTimestamp: NOW - PUSH_MAX_MESSAGE_AGE_MS, messageId: freshId }, NOW)).toBe(true);
    expect(isPushFresh({ canonicalTimestamp: NOW - PUSH_MAX_MESSAGE_AGE_MS - 1, messageId: freshId }, NOW)).toBe(false);
  });

  test("falls back to the ULID time when canonicalTimestamp is absent", () => {
    // No override (native messages): the event ULID time IS the message time.
    expect(isPushFresh({ messageId: freshId }, NOW)).toBe(true);
    expect(isPushFresh({ messageId: oldId }, NOW)).toBe(false);
  });

  test("undecodable message id is treated as fresh, never dropped", () => {
    // The gate is an age check. "Age unknown" must not silently swallow a
    // live notification — that is the opposite failure, and a worse one.
    expect(isPushFresh({ messageId: "not-a-ulid" }, NOW)).toBe(true);
  });

  test("timestamp far in the future is not treated as live", () => {
    const ahead = NOW + 60 * 60 * 1000;
    expect(isPushFresh({ canonicalTimestamp: ahead, messageId: freshId }, NOW)).toBe(false);
  });

  test("non-finite canonicalTimestamp falls back to the ULID time", () => {
    expect(isPushFresh({ canonicalTimestamp: Number.NaN, messageId: freshId }, NOW)).toBe(true);
    expect(isPushFresh({ canonicalTimestamp: Number.NaN, messageId: oldId }, NOW)).toBe(false);
  });
});
