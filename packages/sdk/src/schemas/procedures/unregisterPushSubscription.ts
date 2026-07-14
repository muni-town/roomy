/**
 * Schema for `space.roomy.push.unregisterSubscription` (procedure).
 * Source of truth: packages/appserver/src/handlers/space.roomy.push.unregisterSubscription.ts
 *
 * Removes a stored PushSubscription by endpoint. Called on explicit
 * unsubscribe / logout. Idempotent: unregistering an unknown endpoint is
 * not an error.
 */
import { type } from "arktype";

export const NSID = "space.roomy.push.unregisterSubscription" as const;

export const Input = type({
  endpoint: "string",
});

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});