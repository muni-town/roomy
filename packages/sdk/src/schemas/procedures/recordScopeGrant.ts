/**
 * Schema for `space.roomy.auth.recordScopeGrant` (procedure).
 * Source of truth: packages/appserver/src/handlers/space.roomy.auth.recordScopeGrant.ts
 *
 * Upserts the caller's OAuth scope grant: the raw scope string the PDS
 * actually returned from `getTokenInfo()`. Called after every login and after
 * each scope expansion, so it must be idempotent. Fire-and-forget on the
 * client — a failure is non-fatal and self-heals on the next login.
 */
import { type } from "arktype";

export const NSID = "space.roomy.auth.recordScopeGrant" as const;

export const Input = type({
  /** Raw scope string from `getTokenInfo()` — never a tier name. */
  scope: "string",
});

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});
