/**
 * The cache exists for the appserver's per-IP budget: a server-rendered origin
 * is one client for every visitor, and the limiter counts requests before its
 * own response cache. What matters, then, is how many requests leave this
 * process — which is what these tests count.
 *
 * Runs under `node --test` like its neighbours, so the module it exercises
 * imports nothing from SvelteKit.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createReadCache } from "./read-cache.ts";

/** A cache over a hand-advanced clock. */
function cache(overrides: Partial<{ ttlMs: number; maxEntries: number }> = {}) {
  const clock = { t: 0 };
  const reads = createReadCache({
    ttlMs: overrides.ttlMs ?? 1_000,
    maxEntries: overrides.maxEntries ?? 8,
    now: () => clock.t,
  });
  return { reads, clock };
}

/** A read that records each call and resolves with `value()`. */
function counted<T>(value: () => T) {
  const calls: string[] = [];
  const read = async (label = "call") => {
    calls.push(label);
    return value();
  };
  return { calls, read };
}

describe("a read is reused within the TTL", () => {
  test("one request serves repeated renders of the same URL", async () => {
    const { reads, clock } = cache({ ttlMs: 60_000 });
    const { calls, read } = counted(() => ({ name: "space" }));

    const first = await reads.readThrough("u", read);
    clock.t += 59_999;
    const second = await reads.readThrough("u", read);

    assert.deepEqual(first, { name: "space" });
    assert.deepEqual(second, first);
    assert.equal(calls.length, 1);
  });

  test("the read runs again once the TTL passes", async () => {
    const { reads, clock } = cache({ ttlMs: 60_000 });
    const { calls, read } = counted(() => ({ name: "space" }));

    await reads.readThrough("u", read);
    clock.t += 60_001;
    await reads.readThrough("u", read);

    assert.equal(calls.length, 2);
  });

  test("distinct URLs do not share an entry", async () => {
    const { reads } = cache();
    const { calls, read } = counted(() => ({ name: "space" }));

    await reads.readThrough("a", read);
    await reads.readThrough("b", read);

    assert.equal(calls.length, 2);
  });
});

describe("concurrent renders of one URL share one request", () => {
  test("two callers in flight produce a single read", async () => {
    const { reads } = cache();
    const { calls, read } = counted(() => ({ name: "space" }));

    const [a, b] = await Promise.all([
      reads.readThrough("u", read),
      reads.readThrough("u", read),
    ]);

    assert.deepEqual(a, b);
    assert.equal(calls.length, 1);
  });

  test("failures coalesce in flight but are not held afterwards", async () => {
    // `null` is the reads' one failure shape — nonexistent space, invite-only
    // space, rate limit, network failure. Holding it would keep a head on the
    // site defaults after the cause cleared, so the next render asks again.
    const { reads } = cache({ ttlMs: 60_000 });
    const { calls, read } = counted<null>(() => null);

    const [a, b] = await Promise.all([
      reads.readThrough("u", read),
      reads.readThrough("u", read),
    ]);
    assert.equal(a, null);
    assert.equal(b, null);
    assert.equal(calls.length, 1);

    await reads.readThrough("u", read);
    assert.equal(calls.length, 2);
  });
});

describe("the entry cap bounds what a walker can grow", () => {
  test("the oldest entry is dropped once the cap is reached", async () => {
    const { reads } = cache({ maxEntries: 2 });
    const { calls, read } = counted(() => ({ name: "space" }));

    await reads.readThrough("a", read);
    await reads.readThrough("b", read);
    await reads.readThrough("c", read); // drops "a"
    assert.equal(calls.length, 3);

    await reads.readThrough("b", read); // still held
    assert.equal(calls.length, 3);

    await reads.readThrough("a", read); // evicted, so read again
    assert.equal(calls.length, 4);
  });
});
