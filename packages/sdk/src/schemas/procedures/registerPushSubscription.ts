/**
 * Schema for `space.roomy.push.registerSubscription` (procedure).
 * Source of truth: packages/appserver/src/handlers/space.roomy.push.registerSubscription.ts
 *
 * Stores a browser PushSubscription for the caller. Idempotent on endpoint:
 * re-registering the same endpoint updates its keys/expiry rather than
 * duplicating. The input mirrors `PushSubscription.toJSON()` so the client
 * can pass it through verbatim.
 */
import { type } from "arktype";

export const NSID = "space.roomy.push.registerSubscription" as const;

export const SubscriptionKeys = type({
  p256dh: "string",
  auth: "string",
});

export const Input = type({
  endpoint: "string",
  keys: SubscriptionKeys,
  // `PushSubscription.toJSON()` includes `expirationTime` as `null` on
  // browsers that don't issue expiring subscriptions (e.g. Firefox), or as a
  // number (epoch ms) when it does. Accept both; the handler normalizes null
  // → "no expiry" and the DB column is nullable.
  "expirationTime?": "number | null",
});

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});