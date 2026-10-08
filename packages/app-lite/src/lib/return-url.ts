/**
 * The page the user was on before signing in, remembered across the OAuth
 * round-trip.
 *
 * The OAuth `state` parameter is the protocol's CSRF token, not a transport
 * for application data. Both PDS clients mint their own random `state` and keep
 * the matching authorization session under it; forwarding a page path there
 * replaced that generation, so the callback presented a one-character guessable
 * value — rejected outright by a PDS that enforces the spec's entropy guidance
 * (`invalid_state`), and no CSRF protection anywhere else. The return URL
 * therefore lives here, in `sessionStorage`, which the PDS never sees.
 *
 * `sessionStorage` (not `localStorage`) because the value is scoped to the one
 * sign-in attempt: it survives the PDS redirect and the callback in the same
 * tab, and a new tab starts clean rather than inheriting a stale target.
 *
 * `safeReturnUrl` is still applied on the way out as defence in depth. Nothing
 * untrusted reaches this store today — we write it ourselves — but the value
 * becomes a navigation target, so it gets the same same-origin validation a
 * crafted callback URL would need.
 *
 * Pure and storage-injected, so it runs under the Node test runner.
 */

/** The `sessionStorage` key the pending return URL is held under. */
export const RETURN_URL_KEY = "roomy:return-url";

/** The subset of `Storage` this module needs (and that tests can fake). */
export interface ReturnUrlStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `sessionStorage` when a DOM is present; `null` during SSR / in tests. */
function defaultStorage(): ReturnUrlStorage | null {
  return typeof sessionStorage === "undefined" ? null : sessionStorage;
}

/**
 * A root-relative, same-origin navigation target, or `null` for anything else.
 *
 * A crafted callback could put an arbitrary value in the store, so only accept
 * a target that must start with exactly one `/`: rejects absolute URLs
 * (`https://evil.example`), protocol-relative ones (`//evil.example`), and
 * empty strings.
 */
export function safeReturnUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value[0] !== "/" || value[1] === "/") return null;
  return value;
}

/**
 * Record the page to return to after the PDS callback. Call immediately before
 * the browser leaves for the authorization server.
 */
export function rememberReturnUrl(
  url: string,
  storage: ReturnUrlStorage | null = defaultStorage(),
): void {
  const target = safeReturnUrl(url);
  if (!target) return;
  storage?.setItem(RETURN_URL_KEY, target);
}

/**
 * Read the remembered target and clear it, or `null` when there is nowhere to
 * go. Consuming on read keeps one redirect from replaying on every later page
 * load in the tab.
 *
 * `current` is the page being loaded; a target equal to it needs no navigation.
 */
export function consumeReturnUrl(
  current: string,
  storage: ReturnUrlStorage | null = defaultStorage(),
): string | null {
  if (!storage) return null;
  const stored = storage.getItem(RETURN_URL_KEY);
  storage.removeItem(RETURN_URL_KEY);
  const target = safeReturnUrl(stored);
  return target && target !== current ? target : null;
}

/**
 * Whether this page load is an OAuth callback: the authorization server
 * redirected the browser to the fixed redirect URI with `state` plus `code` (or
 * `error`). Exactly the predicate both PDS clients use to recognize a callback,
 * and it must be read before either of them rewrites the address bar.
 */
export function hasOAuthCallbackParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("state") && (params.has("code") || params.has("error"));
}
