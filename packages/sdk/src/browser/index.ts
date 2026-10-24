/**
 * Browser-specific exports for `@roomy/sdk/browser`.
 *
 * This subpath is the only entry that imports browser-only APIs:
 * `@happyview/oauth-client-browser` and `sessionStorage`/`localStorage`.
 *
 * Server consumers (appserver) should **never** import from this subpath.
 * A build-time smoke test verifies this invariant doesn't regress.
 */

// Re-export the session type so consumers don't need a direct dep on
// @happyview/oauth-client-browser just for type imports. It is now a union:
// the HappyView DPoP session type or the legacy @atproto OAuth session.
// NOTE: keep `./oauth` exports in ONE clause — pkgroll drops type-only
// re-exports when merging two `export ... from` clauses of the same module
// (OAuthSession silently vanished from dist/browser/index.d.ts once).
export {
  createOAuthClient,
  makeProxiedAgent,
  initSession,
  login,
  logout,
  type CreateOAuthClientOptions,
  type InitSessionOptions,
  type OAuthSession,
} from "./oauth";

export {
  NativeSessionMirror,
  NATIVE_SESSION_KEY,
  NATIVE_AUTH_DIAGNOSTIC_KEY,
  restoreNativeSession,
  toSnapshot,
  fromSnapshot,
  enableExportableDpopKeys,
  readAuthDiagnostic,
  type NativeAuthDiagnostic,
  type NativeSessionClient,
  type NativeSessionMirrorOptions,
  type NativeSessionSnapshot,
  type SerializedDpopKey,
} from "./native-session";

export { createTanstackCacheAdapter } from "./tanstack";
export { createCachePersistence } from "./persistence";
export type {
  CachePersistence,
  CreateCachePersistenceOptions,
} from "./persistence";
// The seam contracts the browser adaptors are built on. Re-exported so a
// consumer can name the persister and policy it passes without reaching into
// the core namespace for a type.
export type {
  CachePersister,
  Diagnostic,
  PersistedEntry,
  SnapshotPolicy,
} from "../cache/persister";
export { IndexedDbPersister } from "./indexeddb-persister";
export type { IndexedDbPersisterOptions } from "./indexeddb-persister";
// The demotion rule the browser composition applies when it wraps a
// platform's own store — IndexedDB or the shell's — against `localStorage`.
export { withFallback } from "../cache/fallback";
export { LocalStoragePersister } from "./localstorage-persister";
export type {
  LocalStoragePersisterOptions,
  StorageLike,
} from "./localstorage-persister";
export { TauriStorePersister, TAURI_STORE_DEFAULT_KEY } from "./tauri-store-persister";
export type {
  TauriStoreLike,
  TauriStorePersisterOptions,
} from "./tauri-store-persister";
