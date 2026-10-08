import { describe, expect, it } from "vitest";
import { withFallback } from "./fallback";
import { MemoryPersister } from "./memory";
import {
  isPersistableQuery,
  persistedShapeVersion,
  PERSISTED_SHAPE_REVISION,
  readSnapshot,
  selectPersistableEntries,
  writeSnapshot,
  type CachePersister,
  type PersistableQuery,
  type PersistedEntry,
  type PersistedSnapshot,
  type SnapshotPolicy,
} from "./persister";
import { createSnapshotPersister } from "./storage";

const VERSION = persistedShapeVersion("build-abc");
const ACCOUNT = "did:plc:alice";

const policy = (over: Partial<SnapshotPolicy> = {}): SnapshotPolicy => ({
  version: VERSION,
  account: ACCOUNT,
  // Every discard logs; tests that expect one pass a spy, the rest stay quiet.
  onDiagnostic: () => {},
  ...over,
});

const entry = (key: string, state: unknown = key, at = 1): PersistedEntry => ({
  key: [key],
  state,
  at,
});

const query = (over: Partial<PersistableQuery> = {}): PersistableQuery => ({
  queryKey: ["space.roomy.space.getSpaces"],
  state: { status: "success", data: [{ id: "s1" }], dataUpdatedAt: 5 },
  ...over,
});

describe("rule 1 — a persister never throws into the caller", () => {
  it("load of a never-written MemoryPersister resolves to []", async () => {
    const persister = new MemoryPersister(policy());
    await expect(persister.load()).resolves.toEqual([]);
  });

  it("withFallback returns [] and reports when the primary load throws", async () => {
    const broken: CachePersister = {
      load: async () => {
        throw new Error("quota exceeded");
      },
      save: async () => {},
      clear: async () => {},
    };
    const seen: string[] = [];
    const wrapped = withFallback(broken, new MemoryPersister(policy()), (m) =>
      seen.push(m),
    );

    await expect(wrapped.load()).resolves.toEqual([]);
    expect(seen.some((m) => m.includes("fallback"))).toBe(true);
  });

  it("withFallback resolves save and clear even when the delegate throws", async () => {
    const broken: CachePersister = {
      load: async () => [],
      save: async () => {
        throw new Error("write failed");
      },
      clear: async () => {
        throw new Error("clear failed");
      },
    };
    const wrapped = withFallback(broken, new MemoryPersister(policy()));

    await expect(wrapped.save([entry("x")])).resolves.toBeUndefined();
    await expect(wrapped.clear()).resolves.toBeUndefined();
  });
});

describe("rule 1 — the store degrades to the fallback, not to a wrong view", () => {
  it("subsequent reads and writes go to the fallback after one load failure", async () => {
    const broken: CachePersister = {
      load: async () => {
        throw new Error("corrupt store");
      },
      save: async () => {},
      clear: async () => {},
    };
    const fallback = new MemoryPersister(policy());
    await fallback.save([entry("space.roomy.space.getSpaces", "kept")]);

    const wrapped = withFallback(broken, fallback);

    // First load cannot use a fallback it has not switched to yet.
    await expect(wrapped.load()).resolves.toEqual([]);

    // The failure switched the delegate: the fallback's own snapshot is
    // now what a load returns.
    const restored = await wrapped.load();
    expect(restored.map((e) => e.key[0])).toEqual([
      "space.roomy.space.getSpaces",
    ]);
    expect(restored[0]?.state).toBe("kept");
  });
});

describe("rule 2 — the snapshot is versioned", () => {
  it("writeSnapshot stamps the version, account and write time", () => {
    const snapshot = writeSnapshot([entry("a")], {
      version: VERSION,
      account: ACCOUNT,
    });
    expect(snapshot.version).toBe(VERSION);
    expect(snapshot.account).toBe(ACCOUNT);
    expect(typeof snapshot.savedAt).toBe("number");
    expect(snapshot.entries).toHaveLength(1);
  });

  it("the version carries the shape revision and the build identity", () => {
    expect(persistedShapeVersion("build-abc")).toBe(
      `${PERSISTED_SHAPE_REVISION}:build-abc`,
    );
    expect(persistedShapeVersion("build-abc")).not.toBe(
      persistedShapeVersion("build-xyz"),
    );
  });

  it("discards a snapshot written by another build, whole", () => {
    const raw = writeSnapshot([entry("a")], {
      version: persistedShapeVersion("build-OLD"),
      account: ACCOUNT,
    });
    expect(readSnapshot(raw, policy())).toEqual([]);
  });

  it("discards a snapshot whose version the current build does not know", () => {
    const raw: PersistedSnapshot = {
      version: `${PERSISTED_SHAPE_REVISION + 1}:build-abc`,
      account: ACCOUNT,
      savedAt: 0,
      entries: [entry("a")],
    };
    expect(readSnapshot(raw, policy())).toEqual([]);
  });

  it("discards raw bytes that do not form a snapshot object, and reports", () => {
    const seen: string[] = [];
    const p = policy({ onDiagnostic: (m) => seen.push(m) });
    expect(readSnapshot("not a snapshot", p)).toEqual([]);
    expect(readSnapshot({ version: VERSION }, p)).toEqual([]);
    expect(
      readSnapshot({ ...writeSnapshot([], p), savedAt: "soon" }, p),
    ).toEqual([]);
    expect(seen).toHaveLength(3);
  });
});

describe("an absent snapshot is empty, not corrupt", () => {
  it("a never-written key restores nothing and reports nothing", () => {
    const seen: string[] = [];
    const p = policy({ onDiagnostic: (m) => seen.push(m) });

    expect(readSnapshot(undefined, p)).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("a persister over a never-written key reports nothing", async () => {
    const seen: string[] = [];
    const persister = createSnapshotPersister({
      policy: policy({ onDiagnostic: (m) => seen.push(m) }),
      read: async () => undefined,
      write: async () => {},
      remove: async () => {},
    });

    await expect(persister.load()).resolves.toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("rule 3 — the snapshot is scoped to an account", () => {
  it("restores a snapshot written for the current DID", () => {
    const raw = writeSnapshot([entry("a")], {
      version: VERSION,
      account: ACCOUNT,
    });
    expect(readSnapshot(raw, policy())).toHaveLength(1);
  });

  it("discards a snapshot written for another DID", () => {
    const raw = writeSnapshot([entry("a")], {
      version: VERSION,
      account: "did:plc:bob",
    });
    expect(readSnapshot(raw, policy())).toEqual([]);
  });

  it("an unauthenticated session restores nothing", () => {
    const raw = writeSnapshot([entry("a")], {
      version: VERSION,
      account: ACCOUNT,
    });
    expect(readSnapshot(raw, policy({ account: "" }))).toEqual([]);
  });
});

describe("a snapshot is restored whatever its age", () => {
  it("keeps a snapshot written long ago", () => {
    // Age is not a reason to discard: a restored value is stale from the
    // moment it is restored, and the restore's invalidation is what makes the
    // mounted query refetch it. Dropping it would leave the view empty.
    const raw = writeSnapshot([entry("a")], {
      version: VERSION,
      account: ACCOUNT,
    });
    expect(readSnapshot(raw, policy())).toHaveLength(1);
    expect(
      readSnapshot(
        { ...raw, savedAt: 0 },
        policy(),
      ),
    ).toHaveLength(1);
  });
});

describe("a malformed entry is dropped, the rest of the snapshot survives", () => {
  it("keeps valid entries and drops the ones that cannot be understood", () => {
    const raw: PersistedSnapshot = {
      version: VERSION,
      account: ACCOUNT,
      savedAt: 0,
      entries: [
        entry("good"),
        { key: [], state: 1, at: 0 } as unknown as PersistedEntry,
        { key: ["k"], state: 1 } as unknown as PersistedEntry,
        { key: 42, state: 1, at: 0 } as unknown as PersistedEntry,
        { key: ["k2"], state: 1, at: Number.NaN } as unknown as PersistedEntry,
        "junk" as unknown as PersistedEntry,
        entry("also-good"),
      ],
    };

    const restored = readSnapshot(raw, policy());
    expect(restored.map((e) => e.key[0])).toEqual(["good", "also-good"]);
  });
});

describe("the key set — which queries are persisted", () => {
  it("persists a success query that holds data", () => {
    expect(isPersistableQuery(query())).toBe(true);
    expect(selectPersistableEntries([query()])).toHaveLength(1);
  });

  it("excludes a query that is not in success status", () => {
    expect(isPersistableQuery(query({ state: { status: "pending" } }))).toBe(
      false,
    );
    expect(isPersistableQuery(query({ state: { status: "error" } }))).toBe(
      false,
    );
  });

  it("excludes an error, even a cached one", () => {
    expect(
      isPersistableQuery(
        query({
          state: { status: "success", error: new Error("nope"), data: 1 },
        }),
      ),
    ).toBe(false);
  });

  it("excludes a query the cache is about to collect (gcTime: 0)", () => {
    expect(isPersistableQuery(query({ gcTime: 0 }))).toBe(false);
    expect(selectPersistableEntries([query({ gcTime: 0 })])).toEqual([]);
  });

  it("excludes a query with data undefined", () => {
    expect(
      isPersistableQuery(
        query({ state: { status: "success", data: undefined } }),
      ),
    ).toBe(false);
  });

  it("excludes a query with no usable key", () => {
    expect(isPersistableQuery(query({ queryKey: [] }))).toBe(false);
    expect(
      isPersistableQuery(query({ queryKey: [123] as unknown as string[] })),
    ).toBe(false);
  });

  it("selectPersistableEntries keeps only the persistable queries", () => {
    const kept = query();
    const dropped = query({ gcTime: 0 });
    const entries = selectPersistableEntries([kept, dropped]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key[0]).toBe("space.roomy.space.getSpaces");
    expect(entries[0]?.state).toEqual([{ id: "s1" }]);
    expect(entries[0]?.at).toBe(5);
  });
});

describe("MemoryPersister — the seam is total", () => {
  it("round-trips entries written by save", async () => {
    const persister = new MemoryPersister(policy());
    await persister.save([entry("a", { rows: 1 }), entry("b", { rows: 2 })]);

    const restored = await persister.load();
    expect(restored.map((e) => e.key[0])).toEqual(["a", "b"]);
    expect(restored[0]?.state).toEqual({ rows: 1 });
  });

  it("returns [] after clear", async () => {
    const persister = new MemoryPersister(policy());
    await persister.save([entry("a")]);
    await persister.clear();
    await expect(persister.load()).resolves.toEqual([]);
  });
});
