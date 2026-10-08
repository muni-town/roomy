/**
 * Unit tests for the cache eviction listener.
 *
 * Verifies the per-user-vs-broadcast eviction logic:
 * - Per-user signals (affectedUser set) evict only that user + anon.
 * - Broadcast signals (no affectedUser) sweep all users for the nsid+params.
 * - Non-queryInvalidation events are ignored.
 * - Param-subset matching: a signal with `{ spaceId }` evicts entries cached
 *   with `{ spaceId, includeDeleted }`.
 */

import { describe, it, expect } from "bun:test";
import { attachCacheEvictionListener } from "./evictListener.ts";
import { QueryCache } from "./queryCache.ts";
import { Router } from "../invalidation/router.ts";
import type { InvalidationEvent, QueryNsid } from "../invalidation/types.ts";
import type { UserDid, Ulid } from "@roomy-space/sdk";
function qInvalidation(
  nsid: QueryNsid,
  params: Record<string, string>,
  affectedUser?: UserDid,
): InvalidationEvent {
  return {
    kind: "queryInvalidation",
    signal: { nsid, params, affectedUser },
  };
}

describe("attachCacheEvictionListener", () => {
  it("evicts only the affected user + anon on a per-user signal", () => {
    const cache = new QueryCache();
    cache.set("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:1", "u1");
    cache.set("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:2", "u2");
    cache.set("space.roomy.space.getMetadata", { spaceId: "s1" }, null, "anon");

    const router = new Router();
    const unsub = attachCacheEvictionListener(router, cache);

    router.emit([
      qInvalidation("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:1" as UserDid),
    ]);

    expect(cache.get("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:1"))
      .toBeUndefined();
    expect(cache.get("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:2"))
      .toEqual({ value: "u2" });
    expect(cache.get("space.roomy.space.getMetadata", { spaceId: "s1" }, null))
      .toBeUndefined();

    unsub();
  });

  it("evicts all users on a broadcast signal", () => {
    const cache = new QueryCache();
    cache.set("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:1", "u1");
    cache.set("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:2", "u2");
    cache.set("space.roomy.space.getMetadata", { spaceId: "s1" }, null, "anon");
    cache.set("space.roomy.space.getMetadata", { spaceId: "s2" }, "did:plc:1", "other");

    const router = new Router();
    const unsub = attachCacheEvictionListener(router, cache);

    router.emit([
      qInvalidation("space.roomy.space.getMetadata", { spaceId: "s1" }),
    ]);

    expect(cache.get("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:1"))
      .toBeUndefined();
    expect(cache.get("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:2"))
      .toBeUndefined();
    expect(cache.get("space.roomy.space.getMetadata", { spaceId: "s1" }, null))
      .toBeUndefined();
    // Other space retained.
    expect(cache.get("space.roomy.space.getMetadata", { spaceId: "s2" }, "did:plc:1"))
      .toEqual({ value: "other" });

    unsub();
  });

  it("ignores non-queryInvalidation events", () => {
    const cache = new QueryCache();
    cache.set("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:1", "v");

    const router = new Router();
    const unsub = attachCacheEvictionListener(router, cache);

    // A messageDiff event should not evict any cache entry.
    router.emit([
      {
        kind: "messageDiff",
        signal: { roomId: "01ROOM" as Ulid, ops: [] },
      },
    ]);

    expect(cache.get("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:1"))
      .toEqual({ value: "v" });

    unsub();
  });

  it("evicts entries cached with optional params via subset matching", () => {
    const cache = new QueryCache();
    // Cached with includeDeleted (request had the optional param).
    cache.set(
      "space.roomy.space.getMetadata",
      { spaceId: "s1", includeDeleted: "true" },
      "did:plc:1",
      "v",
    );
    // Signal only carries spaceId (inferSignals always emits { spaceId }).
    const router = new Router();
    const unsub = attachCacheEvictionListener(router, cache);

    router.emit([
      qInvalidation("space.roomy.space.getMetadata", { spaceId: "s1" }),
    ]);

    expect(
      cache.get(
        "space.roomy.space.getMetadata",
        { spaceId: "s1", includeDeleted: "true" },
        "did:plc:1",
      ),
    ).toBeUndefined();

    unsub();
  });

  it("evicts the lists whose body holds the named space, and no others", () => {
    // `{ spaceId }` on a getSpaces signal is COVERAGE, not a param: the params
    // of a cached list name no space, so subset matching has nothing to match.
    // The space named is the space whose row moved in the list.
    const cache = new QueryCache();
    const router = new Router();
    const unsub = attachCacheEvictionListener(router, cache);

    const body = (id: string) => ({ spaces: [{ id, unreadCount: 0 }] });

    cache.set("space.roomy.space.getSpaces", {}, "did:plc:1", body("a"));
    cache.set("space.roomy.space.getSpaces", { includeLeft: "true" }, "did:plc:1", body("a"));
    cache.set("space.roomy.space.getSpaces", {}, "did:plc:2", body("b"));
    cache.set("space.roomy.space.getMetadata", { spaceId: "a" }, "did:plc:1", "meta");

    router.emit([qInvalidation("space.roomy.space.getSpaces", { spaceId: "a" })]);

    // Both of caller 1's cached shapes (bare and includeLeft) list `a`.
    expect(cache.get("space.roomy.space.getSpaces", {}, "did:plc:1")).toBeUndefined();
    expect(
      cache.get("space.roomy.space.getSpaces", { includeLeft: "true" }, "did:plc:1"),
    ).toBeUndefined();
    // Caller 2's list holds `b`, which the signal did not name.
    expect(cache.get("space.roomy.space.getSpaces", {}, "did:plc:2")).toEqual({
      value: body("b"),
    });
    // Another NSID is untouched.
    expect(cache.get("space.roomy.space.getMetadata", { spaceId: "a" }, "did:plc:1")).toEqual({
      value: "meta",
    });

    unsub();
  });

  it("an empty-param getSpaces signal still sweeps every list", () => {
    // The remaining `{}` signals are the ones whose change is "which spaces
    // this caller belongs to" (a join or a leave): the caller's list does not
    // contain the space yet, so coverage would match nothing and the whole
    // set must be restated. Those signals carry `affectedUser`, which is what
    // keeps them from reaching anyone else.
    const cache = new QueryCache();
    cache.set("space.roomy.space.getSpaces", {}, "did:plc:1", "v1");
    cache.set("space.roomy.space.getSpaces", { includeLeft: "true" }, "did:plc:1", "v2");
    cache.set("space.roomy.space.getSpaces", {}, "did:plc:2", "v3");

    const router = new Router();
    const unsub = attachCacheEvictionListener(router, cache);

    router.emit([qInvalidation("space.roomy.space.getSpaces", {}, "did:plc:1" as UserDid)]);

    expect(cache.get("space.roomy.space.getSpaces", {}, "did:plc:1")).toBeUndefined();
    expect(
      cache.get("space.roomy.space.getSpaces", { includeLeft: "true" }, "did:plc:1"),
    ).toBeUndefined();
    expect(cache.get("space.roomy.space.getSpaces", {}, "did:plc:2")).toEqual({ value: "v3" });

    unsub();
  });

  it("unsubscribe stops eviction", () => {
    const cache = new QueryCache();
    cache.set("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:1", "v");

    const router = new Router();
    const unsub = attachCacheEvictionListener(router, cache);
    unsub();

    router.emit([
      qInvalidation("space.roomy.space.getMetadata", { spaceId: "s1" }),
    ]);

    // Entry retained after unsub.
    expect(cache.get("space.roomy.space.getMetadata", { spaceId: "s1" }, "did:plc:1"))
      .toEqual({ value: "v" });
  });

  it("handles room.getMetadata per-user eviction", () => {
    const cache = new QueryCache();
    cache.set("space.roomy.room.getMetadata", { roomId: "r1" }, "did:plc:1", "u1");
    cache.set("space.roomy.room.getMetadata", { roomId: "r1" }, "did:plc:2", "u2");

    const router = new Router();
    const unsub = attachCacheEvictionListener(router, cache);

    // updateSeen emits room.getMetadata with affectedUser.
    router.emit([
      qInvalidation("space.roomy.room.getMetadata", { roomId: "r1" }, "did:plc:1" as UserDid),
    ]);

    expect(cache.get("space.roomy.room.getMetadata", { roomId: "r1" }, "did:plc:1"))
      .toBeUndefined();
    expect(cache.get("space.roomy.room.getMetadata", { roomId: "r1" }, "did:plc:2"))
      .toEqual({ value: "u2" });

    unsub();
  });
});

/**
 * `space.getActivityFeed` is the one cached query whose params do NOT name the
 * thing the signal names. Its params key a space as a *filter*
 * (`{ spaceId: "X" }` = only X's rooms) while a signal's `spaceId` names the
 * space a write touched, so the subset rule would read `{ spaceId: "X" }` as a
 * superset of nothing and evict every page. These two tests pin both
 * directions of the replacement rule.
 */
describe("attachCacheEvictionListener: getActivityFeed is evicted by coverage", () => {
  const FEED = "space.roomy.space.getActivityFeed" as QueryNsid;

  it("a scoped write evicts only pages covering that space", () => {
    const cache = new QueryCache();
    const router = new Router();
    attachCacheEvictionListener(router, cache);

    cache.set(FEED, { spaceId: "x" }, "did:plc:1", "feed-x");
    cache.set(FEED, { spaceId: "x", limit: "20" }, "did:plc:1", "feed-x-20");
    cache.set(FEED, { spaceId: "y" }, "did:plc:1", "feed-y");
    cache.set(FEED, {}, "did:plc:1", "feed-all");
    cache.set(FEED, { limit: "20" }, "did:plc:2", "feed-all-20");

    // A write in space x.
    router.emit([qInvalidation(FEED, { spaceId: "x" })]);

    // x's pages are stale: a bare signal must reach the same space with extra
    // params (the client caches `{ spaceId, limit }`), and every user's copy.
    expect(cache.get(FEED, { spaceId: "x" }, "did:plc:1")).toBeUndefined();
    expect(cache.get(FEED, { spaceId: "x", limit: "20" }, "did:plc:1")).toBeUndefined();
    // A page covering every space holds x's rooms, so it is stale too.
    expect(cache.get(FEED, {}, "did:plc:1")).toBeUndefined();
    expect(cache.get(FEED, { limit: "20" }, "did:plc:2")).toBeUndefined();
    // y's page never showed x's rooms — it must survive.
    expect(cache.get(FEED, { spaceId: "y" }, "did:plc:1")).toEqual({ value: "feed-y" });
  });

  it("a write in one space leaves other spaces' pages cached", () => {
    const cache = new QueryCache();
    const router = new Router();
    attachCacheEvictionListener(router, cache);

    for (const space of ["a", "b", "c"]) {
      cache.set(FEED, { spaceId: space }, "did:plc:1", `feed-${space}`);
    }

    router.emit([qInvalidation(FEED, { spaceId: "a" })]);

    expect(cache.get(FEED, { spaceId: "a" }, "did:plc:1")).toBeUndefined();
    expect(cache.get(FEED, { spaceId: "b" }, "did:plc:1")).toEqual({ value: "feed-b" });
    expect(cache.get(FEED, { spaceId: "c" }, "did:plc:1")).toEqual({ value: "feed-c" });
    expect(cache.stats.evictions).toBe(1);
  });

  it("an unscoped signal still evicts every page, including space-filtered ones", () => {
    // Joining or leaving a space restates the whole feed for that caller:
    // which spaces are in it changes, so even a `{ spaceId }` page's contents
    // are no longer trustworthy.
    const cache = new QueryCache();
    const router = new Router();
    attachCacheEvictionListener(router, cache);

    for (const space of ["a", "b"]) {
      cache.set(FEED, { spaceId: space }, "did:plc:1", `feed-${space}`);
    }
    cache.set(FEED, {}, "did:plc:1", "feed-all");
    cache.set(FEED, { spaceId: "a" }, "did:plc:2", "feed-other-user");

    // The joining/leaving user's own feed, broadcast on an empty param set.
    router.emit([qInvalidation(FEED, {}, "did:plc:1" as UserDid)]);

    expect(cache.get(FEED, {}, "did:plc:1")).toBeUndefined();
    expect(cache.get(FEED, { spaceId: "a" }, "did:plc:1")).toBeUndefined();
    expect(cache.get(FEED, { spaceId: "b" }, "did:plc:1")).toBeUndefined();
    // Another user's page is untouched — the change was caller-scoped.
    expect(cache.get(FEED, { spaceId: "a" }, "did:plc:2")).toEqual({
      value: "feed-other-user",
    });
  });

  it("a broadcast unscoped signal evicts every user's every page", () => {
    const cache = new QueryCache();
    const router = new Router();
    attachCacheEvictionListener(router, cache);

    cache.set(FEED, {}, "did:plc:1", "u1-all");
    cache.set(FEED, { spaceId: "a" }, "did:plc:1", "u1-a");
    cache.set(FEED, { spaceId: "b" }, "did:plc:2", "u2-b");

    router.emit([qInvalidation(FEED, {})]);

    expect(cache.stats.size).toBe(0);
  });

  it("leaves other NSIDs' entries alone", () => {
    const cache = new QueryCache();
    const router = new Router();
    attachCacheEvictionListener(router, cache);

    cache.set(FEED, { spaceId: "a" }, "did:plc:1", "feed-a");
    cache.set("space.roomy.space.getMetadata", { spaceId: "a" }, "did:plc:1", "meta-a");

    router.emit([qInvalidation(FEED, { spaceId: "b" })]);

    expect(cache.get(FEED, { spaceId: "a" }, "did:plc:1")).toEqual({ value: "feed-a" });
    expect(cache.get("space.roomy.space.getMetadata", { spaceId: "a" }, "did:plc:1")).toEqual({
      value: "meta-a",
    });
  });
});