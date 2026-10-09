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
 *
 * A drop is diagnosed *by key*, not only by count. A bare count is
 * unattributable — "9,238 entries dropped" says nothing about which queries
 * are churning through the budget — so the diagnostic names the evicted keys.
 * It names a bounded sample of them rather than all of them, so the report
 * does not grow with the drop; the count covers the whole evicted set.
 *
 * The message is fixed and the numbers ride in the detail, matching the other
 * diagnostics in this package. Interpolating the count into the message would
 * give every distinct count its own message, and a message is what a log
 * pipeline groups by.
 */
import type { Diagnostic, PersistedEntry } from "./persister";

/** How many entries a persisted set may hold, and what to report dropping. */
export interface EntryBudget {
  /** Keep at most this many entries. `undefined` applies no count cap. */
  maxEntries?: number;
}

/**
 * How many evicted keys one drop names before the rest are covered by the
 * count alone. Enough to attribute a drop to the queries behind it, small
 * enough that the diagnostic does not grow with the drop.
 */
export const DROPPED_KEY_SAMPLE = 5;

/** The message every drop reports under — fixed, so drops group together. */
const DROPPED_MESSAGE = "cache: dropped entries over the persistence budget";

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
    .map((entry, index) => ({ index, entry, at: entry.at }))
    .sort((a, b) => b.at - a.at || a.index - b.index);
  const keep = new Set(ranked.slice(0, max).map((r) => r.index));

  const kept = entries.filter((_, index) => keep.has(index));
  const evicted = ranked.slice(max).map((r) => r.entry);
  onDiagnostic?.(DROPPED_MESSAGE, describeDrop(evicted));
  return kept;
}

/**
 * The detail a drop reports: how many entries went, and the keys of up to
 * {@link DROPPED_KEY_SAMPLE} of them in the order the budget ranked them —
 * most recently written of the dropped first. A string, because the browser
 * console path that carries these diagnostics to the log collector serializes
 * a second argument with `String()` — an object would arrive as
 * `[object Object]`, which is exactly the attribution this exists to give.
 */
function describeDrop(evicted: readonly PersistedEntry[]): string {
  const named = evicted.slice(0, DROPPED_KEY_SAMPLE);
  const keys = named.map((entry) => JSON.stringify(entry.key)).join(" ");
  const rest = evicted.length - named.length;
  return `${evicted.length} dropped: ${keys}${rest > 0 ? ` (+${rest} more)` : ""}`;
}
