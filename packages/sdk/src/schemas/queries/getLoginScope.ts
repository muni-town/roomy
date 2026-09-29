/**
 * Schema for `space.roomy.auth.getLoginScope` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.auth.getLoginScope.ts
 *
 * Resolves a handle to a DID and returns the raw OAuth scope string that user
 * last consented to, or null when the appserver has no stored grant. The
 * client calls this BEFORE it has a token, so `signIn()` can request the
 * scope the user already approved — hence the endpoint is unauthenticated.
 *
 * The `did` in the response saves the client a separate handle resolution.
 */
import { type } from "arktype";

export const NSID = "space.roomy.auth.getLoginScope" as const;

export const Params = type({
  /** Handle (e.g. `alice.bsky.social`) to resolve and look up. */
  handle: "string",
});

export const Response = type({
  /** The DID the handle resolved to. */
  did: "string",
  /** Raw scope string from `getTokenInfo()`, or null when no grant is stored. */
  "scope?": "string | null",
});
