/**
 * Reading and rewriting the persisted query snapshot from a spec.
 *
 * The persistent-cache specs assert on what is on screen after a reload, so
 * they have to put the store into the state they are testing: read what the app
 * wrote, and write back an edited copy. The snapshot is a plain object under one
 * IndexedDB key (`roomy-query-cache` / `snapshots` / `current`), so both are a
 * short evaluate against the page's own database.
 *
 * The same database the app opens, deliberately: a spec that stubbed storage
 * would be testing its own stub rather than the restore path.
 */

import type { Page } from "@playwright/test";

export interface PersistedSnapshotShape {
  savedAt: number;
  entries: Array<{ key: unknown[]; state: unknown; at: number }>;
}

/** The object store the app writes its snapshot into. */
const IDB_DATABASE = "roomy-query-cache";
const IDB_STORE = "snapshots";
const IDB_KEY = "current";

/** Narrow a value read out of IndexedDB to the snapshot shape. */
export function asSnapshot(value: unknown): PersistedSnapshotShape | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("entries" in value) || !("savedAt" in value)) return null;
  const { entries, savedAt } = value as {
    entries: unknown;
    savedAt: unknown;
  };
  if (!Array.isArray(entries) || typeof savedAt !== "number") return null;
  return {
    savedAt,
    entries: entries as PersistedSnapshotShape["entries"],
  };
}

/** Read the persisted snapshot straight out of IndexedDB, in the page. */
export async function readSnapshot(
  page: Page,
): Promise<PersistedSnapshotShape | null> {
  const raw = await page.evaluate(async () => {
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    const open = indexedDB.open("roomy-query-cache");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    const db = await promise;

    if (!db.objectStoreNames.contains("snapshots")) return null;
    const get = db
      .transaction("snapshots", "readonly")
      .objectStore("snapshots")
      .get("current");
    const { promise: got, resolve: gotResolve, reject: gotReject } =
      Promise.withResolvers<unknown>();
    get.onsuccess = () => gotResolve(get.result ?? null);
    get.onerror = () => gotReject(get.error);
    return got;
  });
  return asSnapshot(raw);
}

/**
 * Backdate the stored snapshot by `ageMs`, in place.
 *
 * Both stamps move: `savedAt` is when the snapshot was written, and each
 * entry's `at` is when the value in it was last refreshed. A store aged by only
 * one of them is a state the app itself can never produce.
 */
export async function ageSnapshot(page: Page, ageMs: number): Promise<void> {
  await page.evaluate(
    async ({ database, store, key, ageMs }) => {
      const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
      const open = indexedDB.open(database);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      const db = await promise;

      const read = db.transaction(store, "readonly").objectStore(store).get(key);
      const { promise: got, resolve: gotResolve, reject: gotReject } =
        Promise.withResolvers<Record<string, unknown>>();
      read.onsuccess = () => gotResolve(read.result as Record<string, unknown>);
      read.onerror = () => gotReject(read.error);
      const snapshot = await got;

      const aged = {
        ...snapshot,
        savedAt: (snapshot.savedAt as number) - ageMs,
        entries: (snapshot.entries as Array<Record<string, unknown>>).map(
          (entry) => ({ ...entry, at: (entry.at as number) - ageMs }),
        ),
      };

      const write = db
        .transaction(store, "readwrite")
        .objectStore(store)
        .put(aged, key);
      const { promise: put, resolve: putResolve, reject: putReject } =
        Promise.withResolvers<void>();
      write.onsuccess = () => putResolve();
      write.onerror = () => putReject(write.error);
      await put;
    },
    { database: IDB_DATABASE, store: IDB_STORE, key: IDB_KEY, ageMs },
  );
}
