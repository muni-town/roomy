/**
 * Pure decisions for the OAuth authorization request's options.
 *
 * `login()`/`tauriLogin()` must forward two values into the PDS authorization
 * request: `state` (so the app can round-trip a return URL through the PDS) and
 * `scope` (the *subset* the caller chose — e.g. app-lite requests only `base`
 * at first login).
 *
 * Forwarding `scope` is load-bearing, not cosmetic. `@atproto/oauth-client`'s
 * `authorize()` uses `options?.scope ?? clientMetadata.scope`, so when no
 * `scope` is passed the request silently falls back to the client metadata's
 * full `scope` field — the *ceiling* (every scope the app may ever want,
 * including tiers the caller deliberately withheld). The consent screen then
 * shows the whole ceiling on every first login instead of the intended subset.
 * Omitting `scope` on a request is therefore a different request, not a
 * defaulted one.
 *
 * Kept free of `@atproto/*` and `window` so it runs under the Node unit-test
 * runner without the browser-only OAuth client.
 */

/** Options a PDS authorization request may carry; `undefined` = "pass nothing". */
export interface AuthorizeRequestOptions {
  state?: string;
  scope?: string;
}

/**
 * Build the options object to hand to `signIn()`/`authorize()` from the login
 * options, or `undefined` when neither value is set (so the caller passes a
 * bare `undefined`, exactly as before).
 *
 * Only *set* values are included: a falsy `state`/`scope` must never become a
 * present-but-empty key, which would override a default with an empty string.
 */
export function authorizeRequestOptions(opts: {
  state?: string | null;
  scope?: string;
}): AuthorizeRequestOptions | undefined {
  const out: AuthorizeRequestOptions = {};
  if (opts.state) out.state = opts.state;
  if (opts.scope) out.scope = opts.scope;
  return out.state !== undefined || out.scope !== undefined ? out : undefined;
}
