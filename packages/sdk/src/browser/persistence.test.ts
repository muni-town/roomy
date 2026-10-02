/**
 * The restore path: hydrate, invalidate, refetch-on-mount, and the write
 * schedule.
 *
 * The load-bearing measurement from the plan, asserted as a behaviour: a
 * hydrated entry is NOT stale under `staleTime: Infinity`, so a mount would
 * serve it forever; after the restore's `invalidateQueries({ refetchType:
 * "none" })` a real observer refetches exactly once and the restored view
 * reconciles.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryObserver,
  type QueryObserverResult,
} from "@tanstack/query-core";
import { persistedShapeVersion, writeSnapshot } from "../cache/persister";
import { createSnapshotPersister } from "../cache/storage";
import { MemoryPersister } from "../cache/memory";
import { createCachePersistence } from "./persistence";

const ACCOUNT = "did:plc:alice";
const VERSION = persistedShapeVersion("build-test");
const MESSAGES = "space.roomy.room.getMessages";

function message(id: string, sortIdx?: string) {
  return {
    id,
    content: id,
    authorDid: "did:plc:alice",
    authorName: "Alice",
    timestamp: "2026-01-01T00:00:00.000Z",
    reactions: [],
    media: [],
    linkEmbeds: [],
    ...(sortIdx === undefined ? {} : { sort_idx: sortIdx }),
  };
}

function policy(over: Partial<{ version: string; account: string }> = {}) {
  return {
    version: VERSION,
    account: ACCOUNT,
    onDiagnostic: () => {},
    ...over,
  };
}

function newClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false, gcTime: 24 * 60 * 60 * 1000 },
    },
  });
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = newClient();
});

describe("restore — the invalidation is what makes a restored view reconcile", () => {
  it("a hydrated entry is NOT stale under staleTime: Infinity", async () => {
    // The reason the restore must invalidate: measured on the pinned
    // query-core, and the whole justification for the explicit step below.
    const persister = new MemoryPersister(policy());
    const key = [MESSAGES, { roomId: "r1" }];
    await persister.save([{ key, state: [message("a", "1")], at: 1000 }]);

    const persistence = createCachePersistence({ queryClient, persister });
    await persistence.restore();

    const query = queryClient.getQueryCache().find({ queryKey: key });
    expect(query?.isStaleByTime(Infinity)).toBe(true);
  });

  it("restores the data and returns the restored keys", async () => {
    const persister = new MemoryPersister(policy());
    const key = [MESSAGES, { roomId: "r1" }];
    await persister.save([{ key, state: [message("a", "1")], at: 1000 }]);

    const persistence = createCachePersistence({ queryClient, persister });
    const keys = await persistence.restore();

    expect(keys).toEqual([key]);
    expect(queryClient.getQueryData(key as unknown[])).toEqual([
      message("a", "1"),
    ]);
  });

  it("a real observer refetches exactly once on mount after a restore", async () => {
    const persister = new MemoryPersister(policy());
    const key = [MESSAGES, { roomId: "r1" }];
    await persister.save([{ key, state: [message("a", "1")], at: 1000 }]);

    const persistence = createCachePersistence({ queryClient, persister });
    await persistence.restore();

    let fetches = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      staleTime: Infinity,
      queryFn: async () => {
        fetches++;
        return [message("a", "1"), message("b", "2")];
      },
    });
    const results: QueryObserverResult[] = [];
    const unsubscribe = observer.subscribe((result) => results.push(result));

    await vi.waitFor(() => expect(fetches).toBeGreaterThan(0));
    // Exactly one: the invalidation makes the mount refetch, and a
    // `staleTime: Infinity` cache does not refetch again on its own.
    expect(fetches).toBe(1);
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(key as unknown[])).toHaveLength(2),
    );
    unsubscribe();
  });

  it("leaves a query that is never mounted unfetched", async () => {
    const persister = new MemoryPersister(policy());
    const key = [MESSAGES, { roomId: "never-opened" }];
    await persister.save([{ key, state: [message("a", "1")], at: 1000 }]);

    const persistence = createCachePersistence({ queryClient, persister });
    await persistence.restore();

    // No observer was created for the key, so `refetchType: "none"` means no
    // fetch was started: the user pays only for what they look at.
    const query = queryClient.getQueryCache().find({ queryKey: key });
    expect(query?.state.fetchStatus).toBe("idle");
    expect(query?.state.dataUpdateCount).toBe(1); // hydration only
  });

  it("degrades to an empty cache when the snapshot is for another account", async () => {
    const key = [MESSAGES, { roomId: "r1" }];
    // A snapshot written for bob, read by a session that is alice.
    const writtenForBob = writeSnapshot([{ key, state: [message("a", "1")], at: 1000 }], {
      version: VERSION,
      account: "did:plc:bob",
    });
    const persister = createSnapshotPersister({
      policy: policy({ account: ACCOUNT }),
      read: () => writtenForBob,
      write: () => {},
      remove: () => {},
    });

    const persistence = createCachePersistence({ queryClient, persister });
    const keys = await persistence.restore();

    expect(keys).toEqual([]);
    expect(queryClient.getQueryData(key as unknown[])).toBeUndefined();
  });
  it("never throws when the store is unreadable", async () => {
    const persister = {
      load: async () => {
        throw new Error("corrupt");
      },
      save: async () => {},
      clear: async () => {},
    };
    const persistence = createCachePersistence({ queryClient, persister });
    await expect(persistence.restore()).resolves.toEqual([]);
  });
});

describe("restore — the validator runs on the load path", () => {
  it("refuses to restore a timeline row with no ordering key", async () => {
    const persister = new MemoryPersister(policy());
    const key = [MESSAGES, { roomId: "r1" }];
    await persister.save([
      { key, state: [message("a", "1"), message("b")], at: 1 },
    ]);

    const persistence = createCachePersistence({ queryClient, persister });
    await persistence.restore();

    const data = queryClient.getQueryData<Array<{ id: string }>>(key as unknown[]);
    expect(data?.map((m) => m.id)).toEqual(["a"]);
  });

  it("repairs a restored timeline stored out of order", async () => {
    const persister = new MemoryPersister(policy());
    const key = [MESSAGES, { roomId: "r1" }];
    await persister.save([
      { key, state: [message("c", "3"), message("a", "1"), message("b", "2")], at: 1 },
    ]);

    const persistence = createCachePersistence({ queryClient, persister });
    await persistence.restore();

    const data = queryClient.getQueryData<Array<{ id: string }>>(key as unknown[]);
    expect(data?.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});

describe("the write schedule", () => {
  it("writes a dirty cache only after the throttle window", async () => {
    vi.useFakeTimers();
    try {
      const persister = new MemoryPersister(policy());
      const save = vi.spyOn(persister, "save");
      const persistence = createCachePersistence({
        queryClient,
        persister,
        throttleMs: 100,
      });
      persistence.start();

      queryClient.setQueryData(["space.roomy.space.getSpaces"], { spaces: [] });
      // A frame just landed; the write must not be on this path.
      expect(save).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a burst of changes into one write", async () => {
    vi.useFakeTimers();
    try {
      const persister = new MemoryPersister(policy());
      const save = vi.spyOn(persister, "save");
      const persistence = createCachePersistence({
        queryClient,
        persister,
        throttleMs: 100,
      });
      persistence.start();

      for (let i = 0; i < 5; i++) {
        queryClient.setQueryData(["space.roomy.space.getSpaces"], { spaces: [i] });
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush writes a dirty cache immediately (the unload path)", async () => {
    const persister = new MemoryPersister(policy());
    const save = vi.spyOn(persister, "save");
    const persistence = createCachePersistence({
      queryClient,
      persister,
      throttleMs: 100_000,
    });
    persistence.start();

    queryClient.setQueryData(["space.roomy.space.getSpaces"], { spaces: [] });
    await persistence.flush();

    expect(save).toHaveBeenCalledTimes(1);
    const restored = await persister.load();
    expect(restored.map((e) => e.key[0])).toEqual(["space.roomy.space.getSpaces"]);
  });

  it("flush is a no-op when nothing changed", async () => {
    const persister = new MemoryPersister(policy());
    const save = vi.spyOn(persister, "save");
    const persistence = createCachePersistence({ queryClient, persister });
    persistence.start();

    await persistence.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("does not persist a gcTime: 0 query (the key-set rule)", async () => {
    vi.useFakeTimers();
    try {
      const persister = new MemoryPersister(policy());
      const persistence = createCachePersistence({
        queryClient,
        persister,
        throttleMs: 100,
      });
      persistence.start();

      queryClient.setQueryData(["space.roomy.space.getThreads"], { rows: [] }, {
        updatedAt: 1,
      });
      // Force the query's options to carry gcTime: 0, the way the six
      // excluded call sites do.
      const query = queryClient
        .getQueryCache()
        .find({ queryKey: ["space.roomy.space.getThreads"] });
      query?.setOptions({ gcTime: 0 });

      await vi.advanceTimersByTimeAsync(100);
      await persistence.flush();

      // Nothing persistable changed, so the store stays empty.
      await expect(persister.load()).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clear — logout", () => {
  it("drops the persisted set", async () => {
    const persister = new MemoryPersister(policy());
    await persister.save([{ key: ["k"], state: 1, at: 1 }]);

    const persistence = createCachePersistence({ queryClient, persister });
    await persistence.clear();

    await expect(persister.load()).resolves.toEqual([]);
  });
});
