/**
 * Browser-specific exports for `@roomy/sdk/browser`.
 *
 * This subpath is the only entry that imports browser-only APIs:
 * `@atproto/oauth-client-browser` and `sessionStorage`.
 *
 * Server consumers (appserver) should **never** import from this subpath.
 * A build-time smoke test verifies this invariant doesn't regress.
 */

// Re-export the session type so consumers don't need a direct dep on
// @atproto/oauth-client-browser just for type imports.
export type { OAuthSession } from "@atproto/oauth-client-browser";

export {
  createOAuthClient,
  makeProxiedAgent,
  saveAppserverDid,
  loadAppserverDid,
  initSession,
  login,
  logout,
  DEFAULT_APPSERVER_DID,
  type CreateOAuthClientOptions,
  type InitSessionOptions,
} from "./oauth";

export { createTanstackCacheAdapter } from "./tanstack";
