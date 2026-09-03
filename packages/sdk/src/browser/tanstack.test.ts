import { QueryClient } from "@tanstack/query-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKey } from "../cache/query-key";
import { createTanstackCacheAdapter } from "./tanstack";

describe("createTanstackCacheAdapter", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    // Real QueryClient — no mocking the adapter target. We disable
    // retries so failed (synthetic) refetches don't leak timers.
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
  });

  describe("patch", () => {
    it("invokes the patcher with undefined when no entry exists", () => {
      const adapter = createTanstackCacheAdapter(queryClient);
      const key = queryKey("nsid.test", { id: "a" });
      const patcher = vi.fn().mockReturnValue(["seeded"]);

      adapter.patch<string[]>(key, patcher);

      expect(patcher).toHaveBeenCalledTimes(1);
      expect(patcher).toHaveBeenCalledWith(undefined);
      expect(queryClient.getQueryData(key as unknown[])).toEqual(["seeded"]);
    });

    it("invokes the patcher with the previous value when an entry exists", () => {
      const adapter = createTanstackCacheAdapter(queryClient);
      const key = queryKey("nsid.test", { id: "b" });

      queryClient.setQueryData(key as unknown[], { count: 1 });

      adapter.patch<{ count: number }>(key, (prev) => ({
        count: (prev?.count ?? 0) + 1,
      }));

      expect(queryClient.getQueryData(key as unknown[])).toEqual({ count: 2 });
    });

    it("supports the message-diff pattern: seed empty, then accumulate", () => {
      // Mirrors the playground's #messageDiff handling — successive
      // patches build up a Message[]-shaped cache entry.
      type Msg = { id: string; text: string };
      const adapter = createTanstackCacheAdapter(queryClient);
      const key = queryKey("space.roomy.room.getMessages", {
        roomId: "room-1",
      });

      adapter.patch<Msg[]>(key, (prev) => [
        ...(prev ?? []),
        { id: "m1", text: "hello" },
      ]);
      adapter.patch<Msg[]>(key, (prev) => [
        ...(prev ?? []),
        { id: "m2", text: "world" },
      ]);

      expect(queryClient.getQueryData(key as unknown[])).toEqual([
        { id: "m1", text: "hello" },
        { id: "m2", text: "world" },
      ]);
    });
  });

  describe("invalidate", () => {
    it("delegates to queryClient.invalidateQueries with the provided key", () => {
      const adapter = createTanstackCacheAdapter(queryClient);
      const spy = vi.spyOn(queryClient, "invalidateQueries");
      const key = queryKey("nsid.test", { roomId: "r1" });

      adapter.invalidate(key);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ queryKey: key });
    });

    it("flips matching queries to stale", async () => {
      const adapter = createTanstackCacheAdapter(queryClient);
      const key = queryKey("nsid.test", { roomId: "r1" });

      // Seed a query with data and observe it transition to stale.
      // We use ensureQueryData with a static result so we don't need
      // to wait on a fetch.
      queryClient.setQueryData(key as unknown[], "v1");
      const cacheEntry = queryClient.getQueryCache().find({
        queryKey: key as unknown[],
      });
      expect(cacheEntry?.isStale()).toBe(false);

      adapter.invalidate(key);

      expect(cacheEntry?.isStale()).toBe(true);
    });

    it("invalidates by prefix — nsid-only keys match all param scopes", () => {
      const adapter = createTanstackCacheAdapter(queryClient);
      const k1 = queryKey("nsid.test", { roomId: "r1" });
      const k2 = queryKey("nsid.test", { roomId: "r2" });

      queryClient.setQueryData(k1 as unknown[], "v1");
      queryClient.setQueryData(k2 as unknown[], "v2");

      adapter.invalidate(queryKey("nsid.test"));

      const cache = queryClient.getQueryCache();
      expect(cache.find({ queryKey: k1 as unknown[] })?.isStale()).toBe(true);
      expect(cache.find({ queryKey: k2 as unknown[] })?.isStale()).toBe(true);
    });
  });

  describe("patchAll", () => {
    it("patches every param variant matching the prefix key", () => {
      const adapter = createTanstackCacheAdapter(queryClient);
      // The server bar mounts getSpaces?includeLeft=true; the home page the
      // bare getSpaces. A #roomMetadataDiff must live-patch BOTH.
      const withParams = queryKey("space.roomy.space.getSpaces", {
        includeLeft: "true",
      });
      const bare = queryKey("space.roomy.space.getSpaces");

      queryClient.setQueryData(withParams as unknown[], {
        spaces: [
          { id: "s1", unreadCount: 2, unreadRoomCount: 1, isMember: true, isAdmin: false, roleIds: [] },
        ],
      });
      queryClient.setQueryData(bare as unknown[], {
        spaces: [
          { id: "s1", unreadCount: 2, unreadRoomCount: 1, isMember: true, isAdmin: false, roleIds: [] },
        ],
      });

      adapter.patchAll<{ spaces: Array<{ unreadCount: number }> }>(
        queryKey("space.roomy.space.getSpaces"),
        (prev) => {
          if (!prev) return undefined;
          return {
            spaces: prev.spaces.map((s) => ({
              ...s,
              unreadCount: s.unreadCount + 1,
            })),
          };
        },
      );

      expect(queryClient.getQueryData(withParams as unknown[])).toEqual({
        spaces: [expect.objectContaining({ unreadCount: 3 })],
      });
      expect(queryClient.getQueryData(bare as unknown[])).toEqual({
        spaces: [expect.objectContaining({ unreadCount: 3 })],
      });
    });

    it("creates nothing when no entry matches (no-op, like patch)", () => {
      const adapter = createTanstackCacheAdapter(queryClient);
      const patcher = vi.fn().mockReturnValue(["seeded"]);

      adapter.patchAll<string[]>(
        queryKey("space.roomy.space.getSpaces"),
        patcher,
      );

      // The patcher is never invoked — there is no cache entry to patch —
      // and no entry is created in its place.
      expect(patcher).not.toHaveBeenCalled();
      expect(
        queryClient.getQueryData(
          queryKey("space.roomy.space.getSpaces") as unknown[],
        ),
      ).toBeUndefined();
    });

    it("an undefined-returning patcher leaves matching entries unchanged", () => {
      const adapter = createTanstackCacheAdapter(queryClient);
      const key = queryKey("nsid.test", { id: "a" });
      queryClient.setQueryData(key as unknown[], "v1");

      adapter.patchAll<string>(queryKey("nsid.test"), () => undefined);

      expect(queryClient.getQueryData(key as unknown[])).toBe("v1");
    });
  });
});
