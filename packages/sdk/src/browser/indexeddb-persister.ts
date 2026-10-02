/**
 * Storage-backed {@link CachePersister} adaptors.
 *
 * Both follow the four rules of the seam (§3.2): they never throw into the
 * caller, they are versioned and account-scoped, and they are bounded. The
 * trust decisions are not made here — {@link readSnapshot}/{@link writeSnapshot}
 * own the version, account and age checks, and {@link createSnapshotPersister}
 * owns rule 1 — so this module holds only *storage* concerns: how bytes are
 * read and written, and the platform's own limit.
 *
 * The database name is deliberately its own: `@atproto/oauth-client-browser`
 * keeps the OAuth session in an IndexedDB database of its own, and a cache
 * failure must never be able to fail session restore (§4.1). Separate
 * database, separate name, no shared transaction.
 */
import type { CachePersister, PersistedEntry, SnapshotPolicy } from "../cache/persister";
import type { EntryBudget } from "../cache/bound";
import { createSnapshotPersister } from "../cache/storage";

/** Own database — never the @atproto session store's. */
const IDB_DATABASE = "roomy-query-cache";
const IDB_STORE = "snapshots";
/** One key holds the whole set: the snapshot is already the persisted set. */
const IDB_KEY = "current";
/**
 * Schema version for the object store itself. The *shape* version lives in
 * the snapshot, where core owns it, so a shape change drops the snapshot and
 * never requires a database upgrade.
 */
const IDB_VERSION = 1;

export interface IndexedDbPersisterOptions {
  policy: SnapshotPolicy;
  budget?: EntryBudget;
  /**
   * The factory, injected so a test can supply `fake-indexeddb`'s. Defaults to
   * the global, which is absent during SSR — in which case every operation is
   * a no-op that reports the absence.
   */
  indexedDB?: IDBFactory | null;
  database?: string;
}

/**
 * A persister backed by one IndexedDB object store.
 *
 * The web default. Asynchronous throughout, and the snapshot is a
 * JSON-shaped plain object, so it is stored by structured clone directly —
 * no serialize/parse step, and nothing the store holds is a live reference.
 */
export class IndexedDbPersister implements CachePersister {
  private readonly db: IDBFactory | null;
  private readonly persister: CachePersister;
  private opening: Promise<IDBDatabase> | null = null;

  constructor(opts: IndexedDbPersisterOptions) {
    this.db =
      opts.indexedDB !== undefined
        ? opts.indexedDB
        : typeof indexedDB === "undefined"
          ? null
          : indexedDB;

    this.persister = createSnapshotPersister({
      policy: opts.policy,
      budget: opts.budget,
      read: () => this.read(),
      write: (snapshot) => this.write(snapshot),
      remove: () => this.remove(),
    });
  }

  /** True when the platform offers IndexedDB at all. */
  get available(): boolean {
    return this.db !== null;
  }

  private open(): Promise<IDBDatabase> {
    if (this.opening) return this.opening;
    const factory = this.db;
    if (!factory) return Promise.reject(new Error("IndexedDB is unavailable"));

    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(IDB_DATABASE, IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("IndexedDB open blocked by another tab"));
    }).catch((err) => {
      // A failed open must not be cached forever: drop the rejection so a
      // later call starts a fresh attempt, and let this one surface.
      this.opening = null;
      throw err;
    });
    return this.opening;
  }

  private async read(): Promise<unknown> {
    if (!this.db) return undefined;
    return this.tx("readonly", (store) => store.get(IDB_KEY));
  }

  private async write(snapshot: unknown): Promise<void> {
    if (!this.db) return;
    await this.tx("readwrite", (store) => store.put(snapshot, IDB_KEY));
  }

  private async remove(): Promise<void> {
    if (!this.db) return;
    await this.tx("readwrite", (store) => store.delete(IDB_KEY));
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(IDB_STORE, mode);
      const request = run(transaction.objectStore(IDB_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    });
  }

  async load(): Promise<PersistedEntry[]> {
    return this.persister.load();
  }

  async save(entries: readonly PersistedEntry[]): Promise<void> {
    await this.persister.save(entries);
  }

  async clear(): Promise<void> {
    await this.persister.clear();
  }
}
