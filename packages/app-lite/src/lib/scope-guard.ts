/**
 * Pure, unit-testable scope-guard primitives for the reactive consent flow.
 *
 * This module holds the two decisions the reactive dialogue wiring applies,
 * deliberately free of Svelte runes, `$env`/`$app`, and the SDK — mirroring how
 * `scopes.ts` and `scope-grant.ts` keep testable pure logic out of their
 * reactive wrappers. Both functions run under app-lite's
 * `node --test --experimental-strip-types` runner.
 *
 *   - **`isInsufficientScopeError`** — the narrow predicate that recognises a
 *     resource-server *scope-miss* (the shape a stale session hits mid-request:
 *     `error === "ScopeMissingError"`, `status === 403`). It is intentionally
 *     narrow: the defect Phase 5 exists to prevent is a predicate that matches
 *     everything (a 500, a plain Error, `invalid_scope` at request-time, or a
 *     403 with an unrelated error name would all falsely trigger the consent
 *     dialogue). The shape is source-verified against the atproto version that
 *     ships this app's resource server (see plan Open Question 3).
 *
 *   - **`guardedXrpc`** — runs an XRPC call; on a recognisable scope-miss with a
 *     `requiredTier`, prompts the user to consent (via an injected
 *     `prompt(tier) => Promise<boolean>`), and on acceptance the **prompt** is
 *     responsible for driving `requestScopeExpansion(tier)`. `guardedXrpc`
 *     itself never calls the expansion — the prompt is injected so the pure
 *     core stays testable — and it **never retries** after a decline or an
 *     in-place acceptance, so it cannot loop even in app-password (test) mode
 *     where `requestScopeExpansion` is a no-op.
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
 * True when `err` is a resource-server scope-miss the reactive dialogue should
 * offer to fix — not a request-time `invalid_scope`, not a server 500, not a
 * 403 with a different error name, not a plain Error.
 *
 * Two resource servers can refuse the same call, and they name the failure
 * differently: a PDS reports `ScopeMissingError`; HappyView — which the web
 * client routes through — reports a generic `Forbidden` and puts the
 * explanation in the message. So the error name decides when one is present,
 * and the message decides only when it is not.
 *
 * That ordering is what keeps the predicate narrow. Keying off message text
 * alone would match a 403 from anything that happened to describe itself the
 * same way, which is the failure this predicate exists to avoid.
 *
 *   - named: `error` is one of the scope-miss names, and the status is 403;
 *   - unnamed: no `error` field, status 403, and the message carries one of
 *     the two servers' signatures — the PDS's `Missing required scope`, or
 *     HappyView's `is not authorized for <method>: it needs <scope>`.
 *
 * The 403 requirement is load-bearing in both branches: a bare
 * `error === "ScopeMissingError"` with a 500 (or any non-403) is NOT a
 * scope-miss and must not trigger the dialogue.
 */
export function isInsufficientScopeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;

  const status = typeof e.status === "number" ? e.status : undefined;
  if (status !== SCOPE_MISSING_STATUS) return false;

  // HappyView — a resource server the web client routes through — reports a
  // miss with no name: the descriptive sentence is the `error` value itself
  // (`xrpc/scope_check.rs`). Match it by that sentence, so a genuinely
  // unrelated name (a 403 "AuthRequired", say) is still rejected instead of
  // being read as prose.
  const describesMissingScope = (text: string): boolean =>
    /^Missing required scope/.test(text) ||
    (text.includes("is not authorized for") && text.includes("it needs"));

  const errorName = typeof e.error === "string" ? e.error : undefined;
  if (errorName !== undefined) {
    return (
      SCOPE_MISSING_ERROR_NAMES[errorName] === true ||
      describesMissingScope(errorName)
    );
  }

  // No `error` field at all: the message is the only signal left. Some
  // transports drop the error name, leaving only the PDS's wording.
  return typeof e.message === "string" && describesMissingScope(e.message);
}

/** The user's accept/reject decision for a proposed tier expansion. */
export type ScopeExpansionPrompt = (tier: ScopeSetName) => Promise<boolean>;

export interface GuardedXrpcOptions {
  /**
   * The tier to request an expansion for when the call fails with a
   * recognisable scope-miss. When a feature needs scope it can only express as
   * a tier (the umbrella vocabulary — see scopes.ts), pass that tier here. When
   * a boundary genuinely cannot be expressed as a tier, the caller must NOT
   * invent a parallel vocabulary; leave tier undefined and the error surfaces
   * raw.
   */
  requiredTier?: ScopeSetName;
  /**
   * Prompt the user to consent to expanding to `requiredTier`. Resolves `true`
   * on accept. The prompt (not `guardedXrpc`) drives `requestScopeExpansion`:
   * in a real browser session that navigates away; in app-password (test) mode
   * `requestScopeExpansion` is a no-op, so the prompt should resolve `false`
   * to keep the guarded call from appearing to succeed without a grant.
   */
  prompt?: ScopeExpansionPrompt;
}

/**
 * Run an XRPC call; on a recognisable scope-miss with a `requiredTier` +
 * prompt, surface the consent dialogue instead of the raw error. Accepting the
 * dialogue (via the prompt) navigates away to the PDS on the prompt's `true`;
 * declining leaves the action failed and the UI intact.
 *
 * Never retries the call: after a decline, or after an acceptance that could
 * not navigate away (e.g. app-password mode where `requestScopeExpansion` is a
 * no-op), the original error is rethrown so the caller surfaces a clean,
 * usable failure rather than looping.
 */
export async function guardedXrpc<T>(
  fn: () => Promise<T>,
  options: GuardedXrpcOptions = {},
): Promise<T> {
  const { requiredTier, prompt } = options;
  try {
    return await fn();
  } catch (err) {
    if (requiredTier && prompt && isInsufficientScopeError(err)) {
      // The prompt drives the consent round-trip on accept (navigate-away in
      // OAuth; a no-op in test mode where no OAuth grant exists) and resolves
      // `false` on reject. Either way we never retry — the caller surfaces a
      // clean, usable failure rather than looping.
      await prompt(requiredTier);
    }
    throw err;
  }
}
