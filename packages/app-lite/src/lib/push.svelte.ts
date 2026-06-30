/**
 * Web push subscription orchestrator (client side).
 *
 * On login (`ensurePushSubscription`) we: fetch the appserver's VAPID public
 * key → ask for notification permission → subscribe the service worker's push
 * manager → register the resulting `PushSubscription` with the appserver
 * (keyed by endpoint, idempotent). On logout (`clearPushSubscription`) we
 * unregister the endpoint from the appserver and unsubscribe the browser so
 * this device stops receiving pushes while signed out.
 *
 * The appserver never stores message content in the payload (only counts +
 * room/sender names — see `packages/appserver/src/push/types.ts`), and the
 * service worker builds the visible notification from those (see
 * `src/service-worker.ts`).
 *
 * Everything is guarded and best-effort: push is a progressive enhancement.
 * If the browser lacks service workers / Push API / Notifications, or the
 * user denies permission, or the appserver has no VAPID key configured, we
 * silently skip — never breaking login.
 */

import { px } from "$lib/auth.svelte";
import { registerPushSubscription, unregisterPushSubscription } from "$lib/mutations/push-subscription";

/** localStorage key for the last endpoint we registered (idempotency hint). */
const LAST_ENDPOINT_KEY = "roomy.push.lastEndpoint";

function supportsPush(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/** base64url → Uint8Array (for the VAPID `applicationServerKey`). */
export function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Subscribe (or re-confirm) this device for push after login. Safe to call on
 * every init — re-subscribing an existing endpoint is a no-op on the browser
 * side and an idempotent upsert on the appserver side.
 */
export async function ensurePushSubscription(): Promise<void> {
  if (!supportsPush()) return;

  // Fetch the VAPID public key. Empty string = appserver has no VAPID config
  // (dev/test) — skip subscription entirely.
  let vapidKey: string;
  try {
    const res = await px().query("space.roomy.push.getVapidPublicKey", {});
    vapidKey = res.publicKey;
  } catch (e) {
    console.warn("[push] could not fetch VAPID public key:", e);
    return;
  }
  if (!vapidKey) return;

  // Ask the user for permission. If denied, we skip — no silent background
  // subscription. We intentionally ask here (on first login) rather than on
  // a cold page load, so the prompt is tied to a user action.
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch (e) {
    console.warn("[push] Notification.requestPermission threw:", e);
    return;
  }
  if (permission !== "granted") return;

  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    console.debug("[push] serviceWorker.ready; existing subscription:", existing?.endpoint ?? "none");
    const subscription =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true, // required by all browsers; we always show a notification
        applicationServerKey: base64UrlToUint8Array(vapidKey) as BufferSource,
      }));
    console.debug("[push] pushManager.subscribe ok; endpoint:", subscription.endpoint);

    await registerPushSubscription(subscription);
    console.info("[push] registered subscription with appserver:", subscription.endpoint);
    localStorage.setItem(LAST_ENDPOINT_KEY, subscription.endpoint);
  } catch (e) {
    // Stage-tag the error so the browser console pinpoints which step failed
    // (SW ready / subscribe / XRPC register). The message includes the error
    // name + message + any XRPC payload so a 401/400 is visible at a glance.
    const err = e as { name?: string; message?: string; statusCode?: number; payload?: unknown };
    console.error(
      "[push] subscription failed at subscribe/register:" +
        ` ${err?.name ?? "Error"}${err?.statusCode ? ` (${err.statusCode})` : ""}:` +
        ` ${err?.message ?? e}`,
      err?.payload ?? "",
    );
  }
}

/**
 * Unsubscribe this device on logout so the appserver stops delivering to it
 * while the user is signed out. Best-effort: a network failure here must not
 * block logout.
 */
export async function clearPushSubscription(): Promise<void> {
  if (!supportsPush()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (subscription) {
      // Tell the appserver first (so we stop delivering), then drop the local
      // subscription. If the appserver call fails we still unsubscribe locally.
      try {
        await unregisterPushSubscription(subscription.endpoint);
      } catch (e) {
        console.warn("[push] unregister endpoint failed (continuing):", e);
      }
      await subscription.unsubscribe();
    }
    localStorage.removeItem(LAST_ENDPOINT_KEY);
  } catch (e) {
    console.warn("[push] clearPushSubscription failed:", e);
  }
}