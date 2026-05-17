/**
 * Schema for the `#invalidate` WS frame body.
 * Sent server → client over `space.roomy.sync.subscribe`.
 * Source of truth: packages/appserver/src/sync/handler.ts (#routeQueryInvalidation).
 *
 * Header is `{ op: 1, t: "#invalidate" }`. The body's `params` map is the
 * stringly-typed query-key fragment used to compute the TanStack cache key
 * `[nsid, params]`.
 */
import { type } from "arktype";

export const T = "#invalidate" as const;

export const Body = type({
  nsid: "string",
  params: { "[string]": "string" },
});
export type Body = typeof Body.infer;
