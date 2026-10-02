/**
 * The degradation rule of the persistence seam.
 *
 * A corrupt, absent, evicted, wrong-version, or wrong-account cache must
 * degrade to an empty cache that fetches; it must never degrade to a
 * wrong view. When the primary store is unreadable the session continues
 * on the fallback store rather than on the broken one.
 *
 * The wrapper is defensive by construction: it holds even when an
 * adaptor violates the never-throws rule of {@link CachePersister}, so
 * the degradation has one implementation instead of one per adaptor.
 */

import type { CachePersister, Diagnostic, PersistedEntry } from "./persister";

export function withFallback(
  primary: CachePersister,
  fallback: CachePersister,
  onDiagnostic?: Diagnostic,
): CachePersister {
  let delegate: CachePersister = primary;

  return {
    async load(): Promise<PersistedEntry[]> {
      try {
        return await delegate.load();
      } catch (err) {
        if (delegate === primary) {
          delegate = fallback;
          onDiagnostic?.(
            "cache: persister load failed; switching to fallback",
            err,
          );
        }
        return [];
      }
    },

    async save(entries: readonly PersistedEntry[]): Promise<void> {
      try {
        await delegate.save(entries);
      } catch (err) {
        onDiagnostic?.("cache: persister save failed", err);
      }
    },

    async clear(): Promise<void> {
      try {
        await delegate.clear();
      } catch (err) {
        onDiagnostic?.("cache: persister clear failed", err);
      }
    },
  };
}
