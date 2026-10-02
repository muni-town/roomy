/**
 * Framework-agnostic cache abstractions.
 *
 * This module deliberately does not import any specific cache
 * library — concrete implementations live in subpath entries
 * (e.g. `@roomy-space/sdk/browser/tanstack`).
 */

// Persistence seam: the storage contract, its core trust rules, and the
// implementations that ship with core. Storage-backed adaptors live under
// subpath entries; core owns which values may be trusted.
export type {
  CachePersister,
  Diagnostic,
  PersistableQuery,
  PersistedEntry,
  PersistedSnapshot,
  SnapshotPolicy,
} from "./persister";
export {
  isPersistableQuery,
  persistedShapeVersion,
  PERSISTED_SHAPE_REVISION,
  readSnapshot,
  selectPersistableEntries,
  writeSnapshot,
} from "./persister";
export { MemoryPersister } from "./memory";
export { withFallback } from "./fallback";
export { validateRestoredEntries } from "./restore";
export type { CacheAdapter, CachePatcher, QueryKey } from "./adapter";
export { queryKey } from "./query-key";
