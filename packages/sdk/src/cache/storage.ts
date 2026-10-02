/**
 * Shared scaffolding for storage-backed {@link CachePersister} adaptors.
 *
 * An adaptor owns only *bytes in, bytes out*: how a snapshot is read and
 * written, and the platform's own limit. Every trust decision is made by core
 * — {@link readSnapshot}/{@link writeSnapshot} own the version, account and age
 * checks, and this wrapper owns rule 1 (a storage failure is a diagnostic,
 * never an application error).
 */
import {
  readSnapshot,
  writeSnapshot,
  type CachePersister,
  type PersistedEntry,
  type SnapshotPolicy,
} from "./persister";
import { boundEntries, type EntryBudget } from "./bound";

export interface SnapshotStoreOptions {
  policy: SnapshotPolicy;
  /** Count budget applied to every save, before the write. */
  budget?: EntryBudget;
  read: () => unknown | Promise<unknown>;
  write: (snapshot: unknown) => void | Promise<void>;
  remove: () => void | Promise<void>;
}

/**
 * Wrap an adaptor's byte-level read/write/remove in the seam's rules.
 *
 * `save` applies the count budget before writing; `load` returns `[]` for
 * anything the store cannot produce, and `save`/`clear` resolve even when the
 * write was rejected (quota, private mode, a corrupt transaction).
 */
export function createSnapshotPersister(opts: SnapshotStoreOptions): CachePersister {
  const { policy } = opts;
  const diag = policy.onDiagnostic;

  return {
    async load(): Promise<PersistedEntry[]> {
      try {
        return readSnapshot(await opts.read(), policy);
      } catch (err) {
        diag?.("cache: persister read failed", err);
        return [];
      }
    },

    async save(entries: readonly PersistedEntry[]): Promise<void> {
      try {
        const bounded = boundEntries(entries, opts.budget ?? {}, diag);
        await opts.write(writeSnapshot(bounded, policy));
      } catch (err) {
        diag?.("cache: persister write failed", err);
      }
    },

    async clear(): Promise<void> {
      try {
        await opts.remove();
      } catch (err) {
        diag?.("cache: persister clear failed", err);
      }
    },
  };
}
