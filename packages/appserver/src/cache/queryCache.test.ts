/**
 * Unit tests for the QueryCache primitive.
 *
 * Covers: hit/miss, TTL expiry, LRU eviction at cap, subset eviction
 * (the critical correctness property that a signal with fewer params than
 * the cached entry still evicts it), per-user key independence, and metrics.
 */

import { describe, it, expect } from "bun:test";
import { QueryCache } from "./queryCache.ts";
import { queryCacheKey } from "./queryCacheKey.ts";

describe("QueryCache", () => {
  it("returns undefined on miss and counts a miss", () => {
    const cache = new QueryCache();
    expect(cache.get("nsid.test", { id: "a" }, "did:plc:1")).toBeUndefined();
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(0);
  });

  it("round-trips a value and counts a hit", () => {
    const cache = new QueryCache();
    const value = { ok: true };
    cache.set("nsid.test", { id: "a" }, "did:plc:1", value);
    const hit = cache.get("nsid.test", { id: "a" }, "did:plc:1");
    expect(hit).toEqual({ value });
    expect(cache.stats.hits).toBe(1);
  });

  it("returns the cached value, not a re-validated copy", () => {
    const cache = new QueryCache();
    const value = { ref: Symbol("x") };
    cache.set("nsid.test", { id: "a" }, "did:plc:1", value);
    const hit = cache.get("nsid.test", { id: "a" }, "did:plc:1");
    expect(hit?.value).toBe(value);
  });

  it("treats different param orderings as the same key", () => {
    const cache = new QueryCache();
    cache.set("nsid.test", { a: "1", b: "2" }, "did:plc:1", "v");
    expect(cache.get("nsid.test", { b: "2", a: "1" }, "did:plc:1")).toEqual({
      value: "v",
    });
  });

  it("treats anon (null) and authenticated DIDs as distinct entries", () => {
    const cache = new QueryCache();
    cache.set("nsid.test", { id: "a" }, null, "anon-val");
    cache.set("nsid.test", { id: "a" }, "did:plc:1", "user-val");
    expect(cache.get("nsid.test", { id: "a" }, null)).toEqual({
      value: "anon-val",
    });
    expect(cache.get("nsid.test", { id: "a" }, "did:plc:1")).toEqual({
      value: "user-val",
    });
    expect(cache.stats.hits).toBe(2);
  });

  it("per-user keys are independent", () => {
    const cache = new QueryCache();
    cache.set("nsid.test", { id: "a" }, "did:plc:1", "u1");
    cache.set("nsid.test", { id: "a" }, "did:plc:2", "u2");
    expect(cache.get("nsid.test", { id: "a" }, "did:plc:1")).toEqual({
      value: "u1",
    });
    expect(cache.get("nsid.test", { id: "a" }, "did:plc:2")).toEqual({
      value: "u2",
    });
  });

  it("expires entries past TTL", () => {
    const cache = new QueryCache({ ttlMs: 5 });
    cache.set("nsid.test", { id: "a" }, "did:plc:1", "v");
    // Still fresh.
    expect(cache.get("nsid.test", { id: "a" }, "did:plc:1")).toEqual({
      value: "v",
    });
    // Wait past TTL.
    const start = Date.now();
    while (Date.now() - start < 20) {
      // busy-wait ~20ms
    }
    expect(cache.get("nsid.test", { id: "a" }, "did:plc:1")).toBeUndefined();
    // TTL-expired entries are counted as misses.
    expect(cache.stats.misses).toBe(1);
  });

  it("evicts the oldest entry when at capacity (LRU)", () => {
    const cache = new QueryCache({ maxEntries: 2 });
    cache.set("nsid.test", { id: "a" }, "did:plc:1", "v1");
    cache.set("nsid.test", { id: "b" }, "did:plc:1", "v2");
    // Touch "a" so it becomes most-recent; "b" is now oldest.
    cache.get("nsid.test", { id: "a" }, "did:plc:1");
    // Insert "c" — evicts the oldest ("b").
    cache.set("nsid.test", { id: "c" }, "did:plc:1", "v3");
    expect(cache.get("nsid.test", { id: "b" }, "did:plc:1")).toBeUndefined();
    expect(cache.get("nsid.test", { id: "a" }, "did:plc:1")).toEqual({
      value: "v1",
    });
    expect(cache.get("nsid.test", { id: "c" }, "did:plc:1")).toEqual({
      value: "v3",
    });
    expect(cache.stats.evictions).toBe(1);
  });

  it("updating an existing key does not grow size or evict", () => {
    const cache = new QueryCache({ maxEntries: 1 });
    cache.set("nsid.test", { id: "a" }, "did:plc:1", "v1");
    cache.set("nsid.test", { id: "a" }, "did:plc:1", "v2");
    expect(cache.size).toBe(1);
    expect(cache.stats.evictions).toBe(0);
    expect(cache.get("nsid.test", { id: "a" }, "did:plc:1")).toEqual({
      value: "v2",
    });
  });
});

describe("QueryCache.evictMatching", () => {
  it("evicts entries where signal params are a subset of cached params", () => {
    const cache = new QueryCache();
    // Cached with optional includeDeleted param.
    cache.set("nsid.test", { spaceId: "s1", includeDeleted: "true" }, "did:plc:1", "v");
    // Signal only carries spaceId (inferSignals always emits { spaceId }).
    cache.evictMatching("nsid.test", { spaceId: "s1" });
    expect(cache.get("nsid.test", { spaceId: "s1", includeDeleted: "true" }, "did:plc:1"))
      .toBeUndefined();
  });

  it("does not evict entries where signal params disagree", () => {
    const cache = new QueryCache();
    cache.set("nsid.test", { spaceId: "s1" }, "did:plc:1", "v");
    cache.evictMatching("nsid.test", { spaceId: "s2" });
    expect(cache.get("nsid.test", { spaceId: "s1" }, "did:plc:1")).toEqual({
      value: "v",
    });
  });

  it("broadcast eviction (no affectedUser) sweeps all userDids for matching params", () => {
    const cache = new QueryCache();
    cache.set("nsid.test", { spaceId: "s1" }, "did:plc:1", "u1");
    cache.set("nsid.test", { spaceId: "s1" }, "did:plc:2", "u2");
    cache.set("nsid.test", { spaceId: "s1" }, null, "anon");
    cache.set("nsid.test", { spaceId: "s2" }, "did:plc:1", "other");
    cache.evictMatching("nsid.test", { spaceId: "s1" });
    expect(cache.get("nsid.test", { spaceId: "s1" }, "did:plc:1")).toBeUndefined();
    expect(cache.get("nsid.test", { spaceId: "s1" }, "did:plc:2")).toBeUndefined();
    expect(cache.get("nsid.test", { spaceId: "s1" }, null)).toBeUndefined();
    // The other-space entry is retained.
    expect(cache.get("nsid.test", { spaceId: "s2" }, "did:plc:1")).toEqual({
      value: "other",
    });
  });

  it("per-user eviction (affectedUser set) evicts only that user + anon", () => {
    const cache = new QueryCache();
    cache.set("nsid.test", { spaceId: "s1" }, "did:plc:1", "u1");
    cache.set("nsid.test", { spaceId: "s1" }, "did:plc:2", "u2");
    cache.set("nsid.test", { spaceId: "s1" }, null, "anon");
    cache.evictMatching("nsid.test", { spaceId: "s1" }, "did:plc:1");
    expect(cache.get("nsid.test", { spaceId: "s1" }, "did:plc:1")).toBeUndefined();
    // Other users are retained.
    expect(cache.get("nsid.test", { spaceId: "s1" }, "did:plc:2")).toEqual({
      value: "u2",
    });
    // Anon is evicted defensively (per-user fields can affect anon visibility).
    expect(cache.get("nsid.test", { spaceId: "s1" }, null)).toBeUndefined();
  });

  it("ignores entries with a different NSID", () => {
    const cache = new QueryCache();
    cache.set("nsid.one", { id: "a" }, "did:plc:1", "v1");
    cache.set("nsid.two", { id: "a" }, "did:plc:1", "v2");
    cache.evictMatching("nsid.one", { id: "a" });
    expect(cache.get("nsid.one", { id: "a" }, "did:plc:1")).toBeUndefined();
    expect(cache.get("nsid.two", { id: "a" }, "did:plc:1")).toEqual({
      value: "v2",
    });
  });

  it("empty signal params match all entries for that NSID", () => {
    const cache = new QueryCache();
    cache.set("nsid.test", {}, "did:plc:1", "v1");
    cache.set("nsid.test", { includeLeft: "true" }, "did:plc:1", "v2");
    cache.evictMatching("nsid.test", {});
    expect(cache.get("nsid.test", {}, "did:plc:1")).toBeUndefined();
    expect(cache.get("nsid.test", { includeLeft: "true" }, "did:plc:1"))
      .toBeUndefined();
  });
});

describe("queryCacheKey", () => {
  it("anon is used when userDid is null", () => {
    expect(queryCacheKey("nsid", {}, null)).toBe("nsid:{}:anon");
  });

  it("is deterministic for the same logical params", () => {
    expect(queryCacheKey("nsid", { b: "2", a: "1" }, "did:plc:1"))
      .toBe(queryCacheKey("nsid", { a: "1", b: "2" }, "did:plc:1"));
  });
});