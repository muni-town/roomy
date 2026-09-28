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

export { createTanstackCacheAdapter } from "./tanstack";
