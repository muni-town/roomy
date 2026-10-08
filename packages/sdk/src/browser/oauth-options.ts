/**
 * Pure decisions for the OAuth authorization request's options.
 *
 * `login()`/`tauriLogin()` forward exactly one value into the PDS
 * authorization request: `scope`, the *subset* the caller chose (e.g.
 * app-lite asks for only `base` at first login).
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
 * `state` is deliberately absent. Both PDS clients already generate their own
 * unguessable `state` and keep the matching authorization session in their own
 * store; a value passed here would *replace* that (the HappyView client does
 * `options?.state ?? randomHex(16)`), which is what made `state` a one-character
 * page path that an OAuth-conforming PDS rejects (`invalid_state`) and that no
 * longer protected the callback against CSRF. An app that wants to remember
 * where the user was keeps that in its own storage, outside the protocol
 * parameter.
 *
 * Kept free of `@atproto/*` and `window` so it runs under the Node unit-test
 * runner without the browser-only OAuth client.
 */

/** Options a PDS authorization request may carry; `undefined` = "pass nothing". */
export interface AuthorizeRequestOptions {
  scope?: string;
}

/**
 * Build the options object to hand to `signIn()`/`authorize()` from the login
 * options, or `undefined` when no value is set (so the caller passes a bare
 * `undefined`, exactly as before).
 *
 * Only a *set* `scope` is included: a falsy value must never become a
 * present-but-empty key, which would override a default with an empty string.
 * `state` is not part of this contract at all — the OAuth client owns that
 * parameter.
 */
export function authorizeRequestOptions(opts: {
  scope?: string;
}): AuthorizeRequestOptions | undefined {
  const out: AuthorizeRequestOptions = {};
  if (opts.scope) out.scope = opts.scope;
  return out.scope !== undefined ? out : undefined;
}
