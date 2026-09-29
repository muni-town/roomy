/**
 * Transport seam for push delivery.
 *
 * The dispatcher owns every delivery *decision* — recipient selection, digests,
 * freshness, per-room coalescing, pruning, failure accounting — and delegates
 * only the outbound call. A transport answers one question: "can you put this
 * payload on this stored subscription's device?" It answers in one vocabulary
 * ({@link PushOutcome}) regardless of whether the device is reached by Web
 * Push, APNs, FCM, or a transport added later.
 *
 * A stored subscription names its transport in `push_subscriptions.kind`;
 * {@link PUSH_TRANSPORTS} maps that to an implementation. Each transport
 * module registers itself there, so no dispatcher policy code names a
 * transport.
 *
 * This module imports nothing: both the transports and the dispatcher depend
 * on it, never the reverse.
 */

/**
 * The transports a stored subscription can name. `webpush` is implemented
 * (`transports/webPush.ts` registers it); `apns`, `fcm` and `sse` have draft
 * registrations that decline delivery, so a row naming one is counted rather
 * than silently dropped.
 */
export type PushTransportKind = "webpush" | "apns" | "fcm" | "sse";

/**
 * A stored subscription as a transport sees it. `endpoint` is the opaque
 * destination — the push-service URL for Web Push, the device token for a
 * native transport — and the credentials are transport-specific: Web Push
 * reads `p256dh`/`auth`, a native transport ignores both. `expirationTime` is
 * epoch ms when the destination is known to expire, else null.
 *
 * `kind` is a plain string rather than {@link PushTransportKind} because it is
 * read from a stored row: a kind this build doesn't know is a rollout gap to
 * report, not a shape error.
 */
export interface PushTarget {
  kind: string;
  endpoint: string;
  p256dh?: string;
  auth?: string;
  expirationTime: number | null;
}

/**
 * Per-call delivery hints, mapped by each transport onto its own wire
 * controls (Web Push `Topic`/`Urgency`/`TTL`; APNs `apns-collapse-id`; FCM
 * `collapse_key`).
 */
export interface PushDeliveryOptions {
  /** Coalescing key: deliveries sharing a topic replace each other (≤32 chars). */
  topic?: string;
  urgency?: "low" | "normal" | "high";
  /** Seconds the push service may hold the message for an offline device. */
  ttl?: number;
}

/**
 * What a transport reports back — the dispatcher's whole outcome vocabulary:
 *
 *  - `delivered` — accepted by the push service. `status` is the response code
 *    it returned.
 *  - `gone` — the destination no longer exists (Web Push 404/410). The
 *    dispatcher prunes the row and never retries it.
 *  - `skipped` — the transport could not attempt delivery because it isn't
 *    configured (no VAPID keypair in dev/test), or because this device is not
 *    reachable by it right now. Nothing was sent and nothing failed, so the
 *    dispatcher counts it apart from both: folding it into `delivered` would
 *    report an unconfigured pipeline as a healthy one, and into `retry` would
 *    report a rollout gap as an outage.
 *  - `retry` — transient or unclassifiable failure (429/5xx/network). The
 *    dispatcher counts it failed and leaves the row in place.
 *
 * `status` carries the transport's own response code where it has one, for
 * diagnostics (a Web Push 429, an APNs 503); it is null when the transport has
 * no status to report (a network error with no response, or a skip).
 *
 * A transport MUST NOT throw: a throw is a bug in the transport, and the
 * dispatcher could not tell it apart from a delivery failure.
 */
export type PushOutcome =
  | { outcome: "delivered"; status: number | null }
  | { outcome: "gone"; status: number | null }
  | { outcome: "skipped"; status: number | null }
  | { outcome: "retry"; status: number | null; error: unknown };

export interface PushTransport {
  readonly kind: PushTransportKind;
  /**
   * Whether this transport could deliver on this appserver right now — its
   * credentials are present and usable. Diagnostics only: delivery does not
   * consult it, because a transport reports its own inability as `skipped`.
   * A draft registration answers false.
   */
  isConfigured(): boolean;
  /** Deliver `body` (the JSON {@link PushPayload}) to one stored subscription. */
  deliver(
    target: PushTarget,
    body: string,
    options: PushDeliveryOptions,
  ): Promise<PushOutcome>;
}

/**
 * Registered transports, keyed by the `kind` a stored subscription carries.
 * Populated by each transport module at import (a registration is an
 * assignment here); read by the dispatcher's delivery loop. A test can install
 * its own entry and delete it afterwards.
 */
export const PUSH_TRANSPORTS: Record<string, PushTransport> = {};
