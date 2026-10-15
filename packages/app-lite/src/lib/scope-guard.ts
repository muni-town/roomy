/**
 * Pure, unit-testable scope-guard primitives for the reactive scope flow.
 *
 * This module holds the decisions the reactive dialogue wiring applies,
 * deliberately free of Svelte runes, `$env`/`$app`, and the SDK — mirroring how
 * `scopes.ts` and `scope-grant.ts` keep testable pure logic out of their
 * reactive wrappers. Everything here runs under app-lite's
 * `node --test --experimental-strip-types` runner.
 *
 *   - **`isInsufficientScopeError`** — the narrow predicate that recognises a
 *     resource-server *scope-miss* (the shape a stale session hits mid-request).
 *     It is intentionally narrow: the defect Phase 5 exists to prevent is a
 *     predicate that matches everything (a 500, a plain Error, `invalid_scope`
 *     at request-time, or a 403 with an unrelated error name would all falsely
 *     trigger the consent dialogue). The shapes are source-verified against the
 *     atproto version that ships this app's resource server, and against
 *     HappyView's forward-time check, which is what the deployed web client
 *     actually meets (see plan Open Question 3).
 *
 *   - **`guardedXrpc`** — runs an XRPC call; on a recognisable scope-miss for a
 *     named tier, calls the injected `prompt(tier) => Promise<boolean>` — the
 *     one place a user learns their session lacks the permission, and the one
 *     place the remedy is chosen: a requestable tier gets the consent dialogue,
 *     a ceiling-only tier gets the "Roomy cannot request this yet" notice. The
 *     prompt owns that choice (and, on consent, driving
 *     `requestScopeExpansion`) so this module stays pure and testable.
 *     `guardedXrpc` **never retries** after a decline or an in-place acceptance,
 *     so it cannot loop even in app-password (test) mode where
 *     `requestScopeExpansion` is a no-op.
 *
 *   - **`SCOPE_UNAVAILABLE_EXPLANATION`** — what the notice shown for a
 *     scope-miss no consent round-trip can fix says.
 */

import type { ScopeSetName } from "./scopes.ts";

/** The resource-server error name `ScopeMissingError` surfaces under. */
export const SCOPE_MISSING_ERROR_NAME = "ScopeMissingError";
/** Additional resource-server names from the OAuth spec, tolerated defensively. */
const SCOPE_MISSING_ERROR_NAMES: Record<string, true> = {
  [SCOPE_MISSING_ERROR_NAME]: true,
  insufficient_scope: true,
  insufficient_scope_required: true,
};

/** The resource-server failure status (http-errors compatibility layer). */
const SCOPE_MISSING_STATUS = 403;

/**
 * The opening of the sentence HappyView's forward-time scope check puts in a
 * 403's `error` field (`src/xrpc/scope_check.rs` → `AppError::Forbidden`).
 *
 * It is the whole body: the refusal carries no error *name*, so a predicate
 * keyed on names alone misses the shape every deployed web user meets and the
 * consent dialogue never opens.
 */
const HAPPYVIEW_REFUSAL_PREFIX = "this session is not authorized for ";

/**
 * True when `err` is a resource-server scope-miss the reactive dialogue should
 * offer to fix — not a request-time `invalid_scope`, not a server 500, not a
 * 403 with a different error name, not a plain Error.
 *
 * Three shapes reach the client for the same failure, one per topology:
 *   - PDS, named: `error === "ScopeMissingError"` (or the OAuth spec's
 *     resource-server names) with `status === 403`.
 *   - PDS, message-only: no `error` field, but the message starts with
 *     `Missing required scope` and the status is 403 (some transports drop the
 *     error name).
 *   - HappyView: `status === 403` and `error` (or, if absent, `message`) starts
 *     with {@link HAPPYVIEW_REFUSAL_PREFIX}. HappyView sits in front of the
 *     user's PDS on the deployed web client, so this is the shape production
 *     sends — its forward-time scope check writes the human sentence into the
 *     `error` field rather than a name.
 *
 * The 403 requirement is load-bearing in every arm: a bare
 * `error === "ScopeMissingError"` (or the HappyView sentence) with a 500, or
 * any non-403, is NOT a scope-miss and must not trigger the dialogue.
 */
export function isInsufficientScopeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;

  const status = typeof e.status === "number" ? e.status : undefined;
  if (status !== SCOPE_MISSING_STATUS) return false;

  const errorName = typeof e.error === "string" ? e.error : undefined;
  if (errorName !== undefined) {
    return (
      SCOPE_MISSING_ERROR_NAMES[errorName] === true ||
      errorName.startsWith(HAPPYVIEW_REFUSAL_PREFIX)
    );
  }

  // No `error` field: fall back to the message signature. Only meaningful for
  // a 403 (already required above).
  const message = typeof e.message === "string" ? e.message : undefined;
  return (
    message !== undefined &&
    (message.startsWith("Missing required scope") ||
      message.startsWith(HAPPYVIEW_REFUSAL_PREFIX))
  );
}

/**
 * The user's answer to a scope prompt. Resolves `true` on accept; a notice with
 * no consent to give (a tier Roomy cannot request yet) resolves `false`.
 *
 * The prompt is where the remedy is chosen, because only it knows what the
 * session can do next: `isRequestableScopeSet(tier)` selects the consent
 * dialogue versus the "cannot request this yet" notice, and on consent the
 * prompt drives `requestScopeExpansion(tier)` — navigating away in a real
 * browser session, a no-op in app-password (test) mode.
 */
export type ScopePrompt = (tier: ScopeSetName) => Promise<boolean>;

export interface GuardedXrpcOptions {
  /**
   * The tier whose scope the call needs, named in the umbrella vocabulary
   * (scopes.ts). Any tier: a requestable one drives the consent round-trip, a
   * ceiling-only one the "not registered yet" notice.
   *
   * A boundary that genuinely cannot be expressed as a tier must NOT invent a
   * parallel vocabulary; leave this undefined and the error surfaces raw.
   *
   * Always pair it with `prompt`: a scope-miss that reaches the caller is then
   * one the user has already been shown, which is what lets callers tell a
   * presented miss from an unhandled failure with `isInsufficientScopeError`.
   */
  requiredScope?: ScopeSetName;
  /**
   * Show the user why the call failed — and what the session can do about it —
   * then resolve with their answer. Resolves `false` when there is nothing the
   * user can consent to, so the guarded call cannot appear to have succeeded.
   */
  prompt?: ScopePrompt;
}

/**
 * Run an XRPC call; on a recognisable scope-miss for `requiredScope`, hand the
 * tier to `prompt` (see {@link ScopePrompt}) instead of leaving the raw error
 * to the caller. Declining — or a notice with nothing to consent to — leaves
 * the action failed and the UI intact.
 *
 * Never retries the call: after a decline, or after an acceptance that could
 * not navigate away (e.g. app-password mode where `requestScopeExpansion` is a
 * no-op), the original error is rethrown. It is recognisable with
 * `isInsufficientScopeError` precisely so callers know the user has already
 * been told, and do not repeat the failure in their own copy.
 */
export async function guardedXrpc<T>(
  fn: () => Promise<T>,
  options: GuardedXrpcOptions = {},
): Promise<T> {
  const { requiredScope, prompt } = options;
  try {
    return await fn();
  } catch (err) {
    if (requiredScope && prompt && isInsufficientScopeError(err)) {
      // The prompt drives the consent round-trip on accept (navigate-away in
      // OAuth; a no-op in test mode where no OAuth grant exists) and resolves
      // `false` on reject. Either way we never retry — the caller surfaces a
      // clean, usable failure rather than looping.
      await prompt(requiredScope);
    }
    throw err;
  }
}

/**
 * What the notice shown for a scope-miss Roomy cannot fix says.
 *
 * A tier is ceiling-only because its scopes are declared in this app's OAuth
 * metadata but not registered on the deployed API client (see
 * `scopes.ts` UNREGISTERED_SCOPES), and the client refuses the whole granted
 * set at session registration. So the permission cannot be part of any new
 * session either: a re-login is not a remedy, and telling the user to try one
 * sends them through a round-trip that cannot change the outcome. The copy says
 * what is true — the permission is not one Roomy can ask for yet — and what
 * happens when it is.
 */
export const SCOPE_UNAVAILABLE_EXPLANATION =
  "Roomy cannot ask for this permission yet, so this session cannot be granted it. " +
  "Signing in again will not change that — the permission has to be added to " +
  "Roomy's sign-in request first. Once it is, you will be prompted to approve it " +
  "and this action will work.";
