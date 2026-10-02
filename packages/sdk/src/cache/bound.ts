/**
 * The bounded rule of the persistence seam (§3.2 rule 4).
 *
 * Unbounded growth is how the reported store corruption happened, so a
 * snapshotted set is capped by *count* rather than bytes: a count cap is
 * deterministic across adaptors, whereas a byte cap depends on the encoding an
 * adaptor happens to use (see the plan, §8 recommendation). An adaptor with
 * its own platform limit — `localStorage`'s ~5 MB class — layers that limit on
 * top, in its own terms.
 *
 * Recency is the eviction policy: the newest entries by `at` are kept, ties
 * going to the later-written one. This is "least-recently-written", the
 * cheapest proxy for the least-recently-*visited* the plan prefers, and it is
 * available without recording a visit counter.
 */
import type { Diagnostic, PersistedEntry } from "./persister";

/** How many entries a persisted set may hold, and what to report dropping. */
export interface EntryBudget {
  /** Keep at most this many entries. `undefined` applies no count cap. */
  maxEntries?: number;
}

/**
 * Trim a set of entries to the count budget, newest first.
 *
 * Returns a new array in the caller's original order, so a caller that only
 * needs trimming never has its ordering changed underneath it.
 */
export function boundEntries(
  entries: readonly PersistedEntry[],
  budget: EntryBudget,
  onDiagnostic?: Diagnostic,
): PersistedEntry[] {
  const max = budget.maxEntries;
  if (max === undefined || entries.length <= max) return [...entries];

  const ranked = entries
    .map((entry, index) => ({ index, at: entry.at }))
    .sort((a, b) => b.at - a.at || b.index - a.index);
  const keep = new Set(ranked.slice(0, max).map((r) => r.index));

  const kept = entries.filter((_, index) => keep.has(index));
  onDiagnostic?.(
    `cache: dropped ${entries.length - kept.length} entries over the persistence budget`,
  );
  return kept;
}
