/**
 * The two storage adaptors, against the four rules of the seam (§3.2).
 *
 * Rule 1 (never throws) is asserted against a store that actively fails — a
 * throwing `localStorage`, a database that cannot open — because the failure
 * it guards is exactly the one that must not reach the app: a quota
 * rejection, a private-mode write refusal, a corrupt store. The other three
 * rules (versioned, account-scoped, bounded) are core's, but an adaptor must
 * not *undo* them: it persists the version it was given, refuses a snapshot
 * written by another, and applies the count budget before writing.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { persistedShapeVersion } from "../cache/persister";
import type { PersistedEntry, SnapshotPolicy } from "../cache/persister";
import { IndexedDbPersister } from "./indexeddb-persister";
import {
  LocalStoragePersister,
  type StorageLike,
} from "./localstorage-persister";

const ACCOUNT = "did:plc:alice";
const VERSION = persistedShapeVersion("build-test");
const KEY = "roomy-query-cache";

function policy(
  over: Partial<SnapshotPolicy> = {},
): SnapshotPolicy {
  return {
    version: VERSION,
    account: ACCOUNT,
    onDiagnostic: () => {},
    ...over,
  };
}

const entry = (key: string, state: unknown = key, at = 1): PersistedEntry => ({
  key: [key],
  state,
  at,
});

/** A working `localStorage` (with its backing map exposed for assertions). */
function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function throwingStorage(error: Error): StorageLike {
  return {
    getItem: () => {
      throw error;
    },
    setItem: () => {
      throw error;
    },
    removeItem: () => {
      throw error;
    },
  };
}

// Each test gets a clean IndexedDB universe.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

const adaptors = [
  {
    name: "IndexedDbPersister",
    make: (): IndexedDbPersister =>
      new IndexedDbPersister({ policy: policy(), indexedDB: new IDBFactory() }),
    absent: (): IndexedDbPersister =>
      new IndexedDbPersister({ policy: policy(), indexedDB: null }),
  },
  {
    name: "LocalStoragePersister",
    make: (): LocalStoragePersister =>
      new LocalStoragePersister({ policy: policy(), storage: memoryStorage() }),
    absent: (): LocalStoragePersister =>
      new LocalStoragePersister({ policy: policy(), storage: null }),
  },
];

for (const { name, make, absent } of adaptors) {
  describe(`${name} — the stored snapshot round-trips`, () => {
    it("round-trips a written set", async () => {
      const persister = make();
      await persister.save([entry("a", { rows: 1 }), entry("b", { rows: 2 })]);

      const restored = await persister.load();
      expect(restored.map((e) => e.key[0])).toEqual(["a", "b"]);
      expect(restored[0]?.state).toEqual({ rows: 1 });
    });

    it("returns [] after clear", async () => {
      const persister = make();
      await persister.save([entry("a")]);
      await persister.clear();
      await expect(persister.load()).resolves.toEqual([]);
    });

    it("is a no-op when the platform store is absent", async () => {
      const persister = absent();
      expect(persister.available).toBe(false);
      await expect(persister.save([entry("a")])).resolves.toBeUndefined();
      await expect(persister.load()).resolves.toEqual([]);
    });
  });
}

describe("rule 1 — a storage failure is a diagnostic, never an application error", () => {
  it("LocalStoragePersister.load returns [] when the store throws", async () => {
    const seen: string[] = [];
    const persister = new LocalStoragePersister({
      policy: policy({ onDiagnostic: (m) => seen.push(m) }),
      storage: throwingStorage(new Error("SecurityError")),
    });

    await expect(persister.load()).resolves.toEqual([]);
    expect(seen.some((m) => m.includes("read failed"))).toBe(true);
  });

  it("LocalStoragePersister.save resolves and reports a QuotaExceededError", async () => {
    const seen: string[] = [];
    const persister = new LocalStoragePersister({
      policy: policy({ onDiagnostic: (m) => seen.push(m) }),
      storage: throwingStorage(new Error("QuotaExceededError")),
    });

    await expect(persister.save([entry("a")])).resolves.toBeUndefined();
    expect(seen.some((m) => m.includes("write failed"))).toBe(true);
  });

  it("LocalStoragePersister.load returns [] for corrupt JSON, and reports", async () => {
    const seen: string[] = [];
    const persister = new LocalStoragePersister({
      policy: policy({ onDiagnostic: (m) => seen.push(m) }),
      storage: memoryStorage({ [KEY]: "{not json" }),
    });

    await expect(persister.load()).resolves.toEqual([]);
    expect(seen.some((m) => m.includes("read failed"))).toBe(true);
  });

  it("IndexedDbPersister.load returns [] when the database cannot open", async () => {
    const seen: string[] = [];
    const broken = {
      open: () => {
        throw new Error("IndexedDB disabled");
      },
    } as unknown as IDBFactory;
    const persister = new IndexedDbPersister({
      policy: policy({ onDiagnostic: (m) => seen.push(m) }),
      indexedDB: broken,
    });

    await expect(persister.load()).resolves.toEqual([]);
    expect(seen.some((m) => m.includes("read failed"))).toBe(true);
  });

  it("clear resolves even when the store throws", async () => {
    const persister = new LocalStoragePersister({
      policy: policy(),
      storage: throwingStorage(new Error("nope")),
    });
    await expect(persister.clear()).resolves.toBeUndefined();
  });
});

describe("rule 4 — the persisted set is bounded", () => {
  it("keeps the newest entries, dropping the oldest over the count budget", async () => {
    const persister = new LocalStoragePersister({
      policy: policy(),
      storage: memoryStorage(),
      budget: { maxEntries: 2 },
    });

    await persister.save([
      entry("oldest", "keep?", 1),
      entry("middle", "keep", 2),
      entry("newest", "keep", 3),
    ]);

    const restored = await persister.load();
    expect(restored.map((e) => e.key[0])).toEqual(["middle", "newest"]);
  });

  it("localStorage drops oldest-first past the byte cap", async () => {
    const persister = new LocalStoragePersister({
      policy: policy(),
      storage: memoryStorage(),
      // Enough for the envelope and a couple of entries, not all of them.
      maxBytes: 220,
    });

    await persister.save([
      entry("a", "x".repeat(80), 1),
      entry("b", "x".repeat(80), 2),
      entry("c", "x".repeat(80), 3),
    ]);

    const restored = await persister.load();
    expect(restored.length).toBeLessThan(3);
    expect(restored.map((e) => e.key[0])).toContain("c");
    expect(restored.map((e) => e.key[0])).not.toContain("a");
  });

  it("still writes an (empty) snapshot when nothing fits", async () => {
    const storage = memoryStorage();
    const persister = new LocalStoragePersister({
      policy: policy(),
      storage,
      maxBytes: 10,
    });

    await persister.save([entry("a", "x".repeat(100), 1)]);
    await expect(persister.load()).resolves.toEqual([]);
    expect(storage.data.get(KEY)).toBeTypeOf("string");
  });
});

describe("the adaptors do not decide what is persisted", () => {
  it("a snapshot from another build is refused on load, whole", async () => {
    const storage = memoryStorage();
    const stale = new LocalStoragePersister({
      policy: policy({ version: persistedShapeVersion("build-old") }),
      storage,
    });
    await stale.save([entry("a")]);

    const current = new LocalStoragePersister({ policy: policy(), storage });
    await expect(current.load()).resolves.toEqual([]);
  });

  it("a snapshot written for another account is refused", async () => {
    const storage = memoryStorage();
    const bob = new LocalStoragePersister({
      policy: policy({ account: "did:plc:bob" }),
      storage,
    });
    await bob.save([entry("a")]);

    const alice = new LocalStoragePersister({ policy: policy(), storage });
    await expect(alice.load()).resolves.toEqual([]);
  });

  it("writes the snapshot envelope core produces, not entries alone", async () => {
    const storage = memoryStorage();
    const persister = new LocalStoragePersister({ policy: policy(), storage });
    await persister.save([entry("a")]);

    const raw = JSON.parse(storage.data.get(KEY) ?? "null");
    expect(raw.version).toBe(VERSION);
    expect(raw.account).toBe(ACCOUNT);
    expect(raw.savedAt).toBeTypeOf("number");
    expect(raw.entries).toHaveLength(1);
  });
});
