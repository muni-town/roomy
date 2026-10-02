/**
 * `localStorage`-backed {@link CachePersister}.
 *
 * The fallback for a platform where IndexedDB is unavailable or has failed —
 * the always-have-a-local-storage-fallback rule. It is synchronous (no load
 * race) and fails loudly (`QuotaExceededError`), but it is small, so it layers
 * a byte cap on top of the core count budget and drops oldest-first within
 * that cap.
 *
 * The byte cap is deliberately a fraction of the platform's ~5 MB class: the
 * origin's `localStorage` is shared with the app's other ad-hoc stores
 * (`roomy-scroll-positions`, `last-login`, …), and a snapshot that filled it
 * would starve them.
 */
import type {
  CachePersister,
  Diagnostic,
  PersistedEntry,
  PersistedSnapshot,
  SnapshotPolicy,
} from "../cache/persister";
import type { EntryBudget } from "../cache/bound";
import { createSnapshotPersister } from "../cache/storage";

/** A few hundred KB of the 5 MB class — see the module comment. */
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_KEY = "roomy-query-cache";

/** The subset of `Storage` this module needs (and that tests can fake). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocalStoragePersisterOptions {
  policy: SnapshotPolicy;
  budget?: EntryBudget;
  /** Storage key. Distinct from the app's other ad-hoc stores. */
  key?: string;
  /**
   * The storage object, injected so a test can supply a fake. Defaults to the
   * global; when absent (SSR, private mode) every operation is a no-op that
   * reports the absence.
   */
  storage?: StorageLike | null;
  /** Hard byte cap. Defaults to {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
}

function defaultStorage(): StorageLike | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export class LocalStoragePersister implements CachePersister {
  private readonly storage: StorageLike | null;
  private readonly maxBytes: number;
  private readonly onDiagnostic: Diagnostic | undefined;
  private readonly persister: CachePersister;

  constructor(opts: LocalStoragePersisterOptions) {
    this.storage = opts.storage !== undefined ? opts.storage : defaultStorage();
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.onDiagnostic = opts.policy.onDiagnostic;

    const key = opts.key ?? DEFAULT_KEY;
    this.persister = createSnapshotPersister({
      policy: opts.policy,
      budget: opts.budget,
      read: () => this.read(key),
      write: (snapshot) => this.write(key, snapshot as PersistedSnapshot),
      remove: () => {
        this.storage?.removeItem(key);
      },
    });
  }

  /** True when the platform offers `localStorage` at all. */
  get available(): boolean {
    return this.storage !== null;
  }

  private read(key: string): unknown {
    const raw = this.storage?.getItem(key);
    if (raw == null) return undefined;
    // A parse failure is a corrupt store; rule 1 turns it into an empty cache
    // — `JSON.parse` throws and the shared persister catches it.
    return JSON.parse(raw) as unknown;
  }

  private write(key: string, snapshot: PersistedSnapshot): void {
    if (!this.storage) return;
    this.storage.setItem(key, JSON.stringify(this.fit(snapshot)));
  }

  /**
   * Trim a snapshot to the byte cap, newest-first.
   *
   * Entries are visited newest-first and kept while they fit; the first that
   * would exceed the cap starts the tail that is dropped, so the oldest go
   * first. The count budget was already applied by the shared persister, so
   * this is only the platform limit, in the platform's terms.
   */
  private fit(snapshot: PersistedSnapshot): PersistedSnapshot {
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length === 0) {
      return snapshot;
    }

    // The envelope (version, account, savedAt) plus empty-list brackets.
    let bytes = JSON.stringify({ ...snapshot, entries: [] }).length;
    const newestFirst = [...snapshot.entries].sort((a, b) => b.at - a.at);
    const kept: PersistedEntry[] = [];
    for (const entry of newestFirst) {
      bytes += JSON.stringify(entry).length + 1; // + the separator comma
      if (bytes > this.maxBytes) break;
      kept.push(entry);
    }

    if (kept.length === newestFirst.length) return snapshot;
    this.onDiagnostic?.(
      `cache: localStorage budget dropped ${newestFirst.length - kept.length} entries`,
    );
    return { ...snapshot, entries: kept };
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
