/**
 * In-process persister backed by a single snapshot slot.
 *
 * Not persistence: it makes the seam total, so the app has exactly one
 * code path and tests exercise the real one. Every read is routed through
 * the core {@link readSnapshot} rules, so a test using this persister is
 * testing a rule rather than an adaptor.
 */

import {
  readSnapshot,
  writeSnapshot,
  type CachePersister,
  type PersistedEntry,
  type PersistedSnapshot,
  type SnapshotPolicy,
} from "./persister";

export class MemoryPersister implements CachePersister {
  private snapshot: PersistedSnapshot | undefined;

  constructor(private readonly policy: SnapshotPolicy) {}

  async load(): Promise<PersistedEntry[]> {
    try {
      return readSnapshot(this.snapshot, this.policy);
    } catch (err) {
      this.policy.onDiagnostic?.("cache: memory persister read failed", err);
      return [];
    }
  }

  async save(entries: readonly PersistedEntry[]): Promise<void> {
    try {
      this.snapshot = writeSnapshot(entries, this.policy);
    } catch (err) {
      this.policy.onDiagnostic?.("cache: memory persister write failed", err);
    }
  }

  async clear(): Promise<void> {
    this.snapshot = undefined;
  }
}
