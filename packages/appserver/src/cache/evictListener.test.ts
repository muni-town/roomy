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
        signal: { roomId: "01ROOM" as Ulid, seq: 1, ops: [] },
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

  it("evicts getSpaces entries with empty signal params (broadcast sweep)", () => {
    const cache = new QueryCache();
    cache.set("space.roomy.space.getSpaces", {}, "did:plc:1", "v1");
    cache.set("space.roomy.space.getSpaces", { includeLeft: "true" }, "did:plc:1", "v2");

    const router = new Router();
    const unsub = attachCacheEvictionListener(router, cache);

    // getSpaces invalidation always uses {} params.
    router.emit([
      qInvalidation("space.roomy.space.getSpaces", {}),
    ]);

    expect(cache.get("space.roomy.space.getSpaces", {}, "did:plc:1")).toBeUndefined();
    expect(
      cache.get("space.roomy.space.getSpaces", { includeLeft: "true" }, "did:plc:1"),
    ).toBeUndefined();

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