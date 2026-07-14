/**
 * VAPID + web-push delivery wrapper.
 *
 * The appserver holds a VAPID keypair (env: `VAPID_PRIVATE_KEY`,
 * `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`). The public key is handed to browsers
 * so they can create a `PushSubscription`; the private key signs the VAPID
 * JWT used for delivery. `web-push` (pure JS, runs under Bun) handles VAPID
 * JWT signing + RFC 8291 (`aes128g2`) payload encryption and POSTs the
 * encrypted body to each subscription's push-service endpoint.
 *
 * Generate a keypair once per environment with `scripts/generate-vapid.ts`.
 * Delivery is a no-op until VAPID is configured, so the appserver boots and
 * serves the lexicons even without keys (useful for tests / dev without push).
 */

import webPush, { type PushSubscription, type WebPushError } from "web-push";
import { log } from "../log.ts";

const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "";

let configured = false;

/** Configure the global VAPID details once. Idempotent and cheap to call. */
function ensureConfigured(): void {
  if (configured) return;
  if (!VAPID_PRIVATE_KEY || !VAPID_PUBLIC_KEY || !VAPID_SUBJECT) {
    // Push delivery is disabled until env keys are present. The lexicons
    // and handlers still work (getVapidPublicKey returns null, register/
    // setPreferences store state); only actual delivery is skipped.
    return;
  }
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
}

/** Whether VAPID is configured and delivery is enabled. */
export function isPushConfigured(): boolean {
  ensureConfigured();
  return configured;
}

/**
 * The VAPID public key to hand to browsers
 * (`pushManager.subscribe({ applicationServerKey })`), or null when VAPID
 * isn't configured.
 */
export function getVapidPublicKey(): string | null {
  ensureConfigured();
  return VAPID_PUBLIC_KEY || null;
}

export interface SendPushResult {
  /** HTTP status from the push service, or null if delivery was skipped. */
  status: number | null;
  /** True when the push service indicated the subscription is gone (404/410). */
  gone: boolean;
}

/**
 * Deliver an encrypted payload to a single subscription endpoint.
 *
 * - Returns `{ status: 2xx, gone: false }` on success.
 * - Returns `{ gone: true }` on 404/410 so the dispatcher can prune the row.
 * - On 429/5xx the promise rejects so the dispatcher can apply backoff.
 * - When VAPID isn't configured, delivery is skipped (resolves with null
 *   status) so the rest of the system stays usable in dev/test.
 */
export async function sendPush(
  subscription: PushSubscription,
  payload: string,
  options: { topic?: string; urgency?: "low" | "normal" | "high"; ttl?: number } = {},
): Promise<SendPushResult> {
  ensureConfigured();
  if (!configured) {
    log.debug("[push] delivery skipped — VAPID not configured");
    return { status: null, gone: false };
  }

  try {
    await webPush.sendNotification(subscription, payload, {
      TTL: options.ttl ?? 2419200, // 4 weeks default
      urgency: options.urgency ?? "normal",
      topic: options.topic,
    });
    return { status: 200, gone: false };
  } catch (err) {
    const e = err as WebPushError;
    const status = typeof e?.statusCode === "number" ? e.statusCode : 0;
    // 404/410 = subscription no longer valid (expired / user unsubscribed).
    // Surface as `gone` so the caller prunes the row instead of retrying.
    if (status === 404 || status === 410) {
      return { status, gone: true };
    }
    // 429 / 5xx and anything else — reject so the dispatcher can back off.
    throw err;
  }
}

/** Predicate for "gone" push-service responses (404/410). */
export function isPushGone(err: unknown): boolean {
  const status = (err as WebPushError)?.statusCode;
  return status === 404 || status === 410;
}