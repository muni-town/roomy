/**
 * Invalidation system: maps materialised events to invalidation signals
 * consumed by WS sync, server cache, and future notification routing.
 */

export { Router } from "./router.ts";
export { inferSignals } from "./inferSignals.ts";
export type {
  AppliedEvent,
  InvalidationEvent,
  InvalidationListener,
  InvalidationRouter,
  MessageDiff,
  MessageDiffOp,
  MessageSnapshot,
  QueryInvalidation,
  QueryNsid,
} from "./types.ts";
