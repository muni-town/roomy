/**
 * Framework-agnostic cache persistence contract.
 *
 * Persistence is a second concern of the same cache {@link CacheAdapter}
 * addresses: the adapter is what the cache is wired to, a persister is
 * where its contents are kept. Storage hangs off this file rather than a
 * parallel hierarchy, and it is keyed by the same canonical query key
 * (`query-key.ts`), so a persisted entry and a patched entry address the
 * same row.
 *
 * Storage is explicitly asynchronous, unlike `CacheAdapter`. The sync
 * layer depends on `patch` being observable immediately after it
 * returns, so persistence is write-behind and never sits on the frame
 * path.
 *
 * This module owns the rules that decide *whether a restored value may
 * be trusted* — the key set, the shape version, the account scope, and
 * the degradation behaviour. An adaptor owns only bytes in, bytes out.
 */

import type { QueryKey } from "./adapter";

/** One persisted cache entry, exactly as the in-memory adapter holds it. */
export interface PersistedEntry {
  /** Canonical key, built via `queryKey()`. */
  key: QueryKey;
  /** The value `CacheAdapter.get()` returns for that key. */
  state: unknown;
  /** Epoch ms this value was written into the cache. */
  at: number;
}

/**
 * A stored snapshot: the persisted set plus the two facts that decide
 * whether it may be restored at all (shape version, owning account) and
 * the one that decides for how long (write time).
 */
export interface PersistedSnapshot {
  /** Persisted-shape version — see {@link persistedShapeVersion}. */
  version: string;
  /** DID the snapshot was written for. */
  account: string;
  /** Epoch ms the snapshot was written. */
  savedAt: number;
  entries: PersistedEntry[];
}

/**
 * Storage surface for the cache, keyed by the canonical {@link QueryKey}.
 *
 * Four rules bind an implementation, each of which exists because of a
 * measured or reported failure:
 *
 * 1. **It never throws into the caller.** `load` resolves to `[]` and
 *    `save`/`clear` resolve on failure; a storage error is a diagnostic,
 *    not an application error. A corrupt-origin failure that surfaces as
 *    a login failure has no place to report itself.
 * 2. **It is versioned.** `load` must reject a snapshot written by a
 *    different persisted-shape version and `save` must write the current
 *    one — a shape change must not be able to produce a half-understood
 *    entry. {@link readSnapshot}/{@link writeSnapshot} implement this.
 * 3. **It is scoped to an account.** The snapshot carries the DID it was
 *    written for; `load` returns `[]` when the current DID differs.
 *    {@link readSnapshot} implements this.
 * 4. **It is bounded.** `save` truncates to a configured budget. The
 *    budget policy is an adaptor concern and is not settled here.
 *
 * Rules 2 and 3 are enforced by the core helpers in this module; an
 * adaptor's obligation is to route its bytes through them.
 */
export interface CachePersister {
  /** Every persisted entry, or empty when there is none / it is unreadable. */
  load(): Promise<PersistedEntry[]>;
  /** Replace the persisted set. Called throttled, never per frame. */
  save(entries: readonly PersistedEntry[]): Promise<void>;
  /** Drop everything. Called on logout and on a detected corrupt store. */
  clear(): Promise<void>;
}

/** Diagnostic sink for discarded snapshots and dropped entries. */
export type Diagnostic = (message: string, detail?: unknown) => void;

/**
 * Revision of the persisted *shape* — the fields a {@link PersistedEntry}
 * and its snapshot carry. Bump this when that shape changes; the
 * snapshot's version also carries the build identity, so a new bundle
 * discards a snapshot written by an older one.
 */
export const PERSISTED_SHAPE_REVISION = 1;

/**
 * Version string a snapshot written by this build carries.
 *
 * The build identity is the app's own (`__BUILD_ID__` in app-lite), so a
 * persisted entry cannot outlive the shape of the row it holds: the
 * dehydrate/hydrate round trip carries `state` across verbatim, without
 * checking that it still means what it meant.
 */
export function persistedShapeVersion(buildId: string): string {
  return `${PERSISTED_SHAPE_REVISION}:${buildId}`;
}

/**
 * The subset of a TanStack query this module needs to decide whether it
 * is worth persisting. Declared structurally so core never imports a
 * cache library.
 */
export interface PersistableQuery {
  queryKey: QueryKey;
  state: {
    status: string;
    error?: unknown;
    data?: unknown;
    dataUpdatedAt?: number;
  };
  gcTime?: number;
}

/**
 * Which queries are persisted: success-status, non-error, non-`gcTime: 0`,
 * with a usable key and data.
 *
 * Mutations are excluded structurally — this predicate takes queries, and
 * the mutation cache has nothing worth persisting (it exists only to
 * route errors). `gcTime: 0` entries are excluded because the cache
 * collects them the moment nothing observes them, so persisting them
 * would store what the cache is about to drop. Errors are excluded
 * because a stale error is strictly worse than no error.
 */
export function isPersistableQuery(query: PersistableQuery): boolean {
  if (query.state.status !== "success") return false;
  if (query.state.error != null) return false;
  if (query.state.data === undefined) return false;
  if (query.gcTime === 0) return false;

  const key = query.queryKey;
  if (!Array.isArray(key) || key.length === 0) return false;
  return typeof key[0] === "string";
}

/**
 * The key-set rule applied to a query cache: the persistable entries,
 * with the key and the value the adapter holds for it.
 */
export function selectPersistableEntries(
  queries: readonly PersistableQuery[],
  now: number = Date.now(),
): PersistedEntry[] {
  const out: PersistedEntry[] = [];
  for (const query of queries) {
    if (!isPersistableQuery(query)) continue;
    out.push({
      key: query.queryKey,
      state: query.state.data,
      at: query.state.dataUpdatedAt ?? now,
    });
  }
  return out;
}

/** The facts a snapshot must match to be restorable. */
export interface SnapshotPolicy {
  /** Version the current build writes — {@link persistedShapeVersion}. */
  version: string;
  /** DID the current session belongs to. An empty account restores nothing. */
  account: string;
  /**
   * Discard the whole snapshot when it is older than this, measured from
   * its write time. `undefined` applies no age limit.
   */
  maxAgeMs?: number;
  /** Diagnostic sink. Defaults to `console.warn`. */
  onDiagnostic?: Diagnostic;
}

/** Stamp a set of entries as the current build's snapshot. */
export function writeSnapshot(
  entries: readonly PersistedEntry[],
  policy: Pick<SnapshotPolicy, "version" | "account">,
  now: number = Date.now(),
): PersistedSnapshot {
  return {
    version: policy.version,
    account: policy.account,
    savedAt: now,
    entries: [...entries],
  };
}

/**
 * Decode an already-parsed snapshot value into entries, discarding
 * whatever cannot be trusted.
 *
 * A snapshot that is absent, unreadable, of another version, of another
 * account, or past its age is discarded whole. An entry that is
 * malformed inside an otherwise valid snapshot is dropped alone, leaving
 * the rest intact: a partial restore is acceptable, a partial entry is
 * not.
 */
export function readSnapshot(
  raw: unknown,
  policy: SnapshotPolicy,
  now: number = Date.now(),
): PersistedEntry[] {
  const diag = policy.onDiagnostic ?? defaultDiagnostic;

  const snapshot = asSnapshot(raw);
  if (!snapshot) {
    diag("cache: snapshot is not a valid snapshot object; discarding");
    return [];
  }

  if (snapshot.version !== policy.version) {
    diag("cache: snapshot has a different shape version; discarding");
    return [];
  }

  if (policy.account === "" || snapshot.account !== policy.account) {
    diag("cache: snapshot belongs to another account; discarding");
    return [];
  }

  if (
    policy.maxAgeMs !== undefined &&
    now - snapshot.savedAt > policy.maxAgeMs
  ) {
    diag("cache: snapshot is older than maxAge; discarding");
    return [];
  }

  const entries: PersistedEntry[] = [];
  for (const candidate of snapshot.entries) {
    const entry = asEntry(candidate);
    if (entry) entries.push(entry);
    else diag("cache: dropping malformed persisted entry");
  }
  return entries;
}

function defaultDiagnostic(message: string, detail?: unknown): void {
  if (detail === undefined) console.warn(message);
  else console.warn(message, detail);
}

function asSnapshot(raw: unknown): PersistedSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.version !== "string") return undefined;
  if (typeof value.account !== "string") return undefined;
  if (typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt)) {
    return undefined;
  }
  if (!Array.isArray(value.entries)) return undefined;
  return {
    version: value.version,
    account: value.account,
    savedAt: value.savedAt,
    entries: value.entries,
  };
}

function asEntry(raw: unknown): PersistedEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const key = value.key;
  if (!Array.isArray(key) || key.length === 0 || typeof key[0] !== "string") {
    return undefined;
  }
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) {
    return undefined;
  }
  if (!("state" in value)) return undefined;
  return { key, state: value.state, at: value.at };
}
