/**
 * Schema for `space.roomy.push.registerSubscription` (procedure).
 * Source of truth: packages/appserver/src/handlers/space.roomy.push.registerSubscription.ts
 *
 * Stores a device's push destination for the caller. Idempotent on endpoint:
 * re-registering the same destination updates its fields rather than
 * duplicating.
 *
 * `kind` names the transport that can reach the device and defaults to
 * `webpush` when omitted, so a browser client keeps sending exactly what it
 * sent before this field existed. `keys` is the RFC 8291 keypair a browser
 * `PushSubscription` carries and is required only for `webpush`; a native
 * device registers its platform token as `endpoint` with no keys. The pairing
 * is enforced in the handler (see that file), not here: this schema is one
 * flat object rather than a kind-discriminated union because the lexicon
 * generator converts a single object shape, and the wire contract has to stay
 * expressible as an atproto lexicon.
 */
import { type } from "arktype";

export const NSID = "space.roomy.push.registerSubscription" as const;

export const SubscriptionKeys = type({
  p256dh: "string",
  auth: "string",
});

export const Input = type({
  endpoint: "string",
  "kind?": "'webpush' | 'apns' | 'fcm' | 'sse'",
  "keys?": SubscriptionKeys,
  // `PushSubscription.toJSON()` includes `expirationTime` as `null` on
  // browsers that don't issue expiring subscriptions (e.g. Firefox), or as a
  // number (epoch ms) when it does. Accept both; the handler normalizes null
  // → "no expiry" and the DB column is nullable.
  "expirationTime?": "number | null",
});

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});
