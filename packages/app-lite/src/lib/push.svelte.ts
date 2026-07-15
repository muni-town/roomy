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

/**
 * Check whether the push-notifications feature flag is enabled for the
 * current user. Returns true if the flag is active (global or per-user).
 * Uses a direct XRPC call (no Tanstack Query — this is a one-shot check
 * at push time, not a reactive query).
 */
async function isPushFeatureEnabled(): Promise<boolean> {
  try {
    const res = await px().query("space.roomy.getFlags", {});
    return res.flags.includes("push-notifications");
  } catch {
    return false;
  }
}

/** localStorage key for the last endpoint we registered (idempotency hint). */
const LAST_ENDPOINT_KEY = "roomy.push.lastEndpoint";

/**
 * Outcome of a subscribe/unsubscribe attempt. Callers (the settings page) use
 * this to surface the right toast; the silent login-time caller ignores it.
 *  - `ok`        — subscription registered (or cleared) successfully.
 *  - `unsupported` — browser lacks Push API / service workers / Notifications.
 *  - `denied`    — the user declined (or previously blocked) the permission prompt.
 *  - `no-key`    — the appserver has no VAPID key configured (push unavailable).
 *  - `timeout`   — `pushManager.subscribe()` didn't resolve in 20s (e.g. a
 *                  Chromium build without Google FCM keys, or the GCM channel
 *                  on port 5228 is blocked).
 *  - `failed`    — any other error (network, XRPC 4xx/5xx); `message` has detail.
 */
export type PushOutcome =
  | { status: "ok" }
  | { status: "unsupported" }
  | { status: "denied" }
  | { status: "no-key" }
  | { status: "disabled" }
  | { status: "timeout" }
  | { status: "failed"; message: string };

export function pushOutcomeMessage(o: PushOutcome): string {
  switch (o.status) {
    case "ok":
      return "Notifications enabled.";
    case "unsupported":
      return "This browser doesn't support web push notifications.";
    case "denied":
      return "Notifications are blocked. Re-enable them in your browser's site permissions, then try again.";
    case "no-key":
      return "Push isn't configured on this server yet.";
    case "disabled":
      return "Push notifications are not available on this server.";
    case "timeout":
      return "Couldn't contact the push service (timed out). Some browsers — like vanilla Chromium without Google keys — can't use web push; try Firefox, Chrome, Edge, Brave, or Safari.";
    case "failed":
      return `Couldn't enable notifications: ${o.message}`;
  }
}

function supportsPush(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}
/**
 * Returns this device's active push subscription endpoint, or `null` if push
 * is unsupported, permission isn't granted, or no subscription exists. Used
 * by the join flow to decide whether to show the `UpdateRhythmChooser`.
 */
export async function getPushSubscriptionEndpoint(): Promise<string | null> {
  if (!supportsPush()) return null;
  if (!(await isPushFeatureEnabled())) return null;
  if (typeof Notification !== "undefined" && Notification.permission !== "granted") {
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
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
 * Subscribe (or re-confirm) this device for push, prompted by an explicit user
 * gesture (the "Enable notifications" button in settings). Safari only allows
 * `Notification.requestPermission()` from within a user gesture, so the
 * permission request MUST be the first async step here — before any network
 * `await`, which would end the gesture's task. Safe to call repeatedly:
 * re-running with permission already granted re-registers the subscription.
 * Returns a {@link PushOutcome} so the caller can toast appropriately.
 */
export async function ensurePushSubscription(): Promise<PushOutcome> {
  if (!supportsPush()) return { status: "unsupported" };
  if (!(await isPushFeatureEnabled())) return { status: "disabled" };

  // Request permission FIRST, synchronously within the gesture (no prior
  // await). If we awaited the VAPID key fetch first, Safari would reject the
  // prompt ("Notification prompting can only be done from a user gesture").
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn("[push] Notification.requestPermission threw:", e);
    return { status: "failed", message };
  }
  if (permission !== "granted") return { status: "denied" };

  return subscribeAndRegister();
}

/**
 * Re-subscribe on login ONLY if the user has already granted notification
 * permission. Never prompts — there's no user gesture at login time, and
 * prompting unprompted on page load is poor UX (and blocked on Safari). The
 * settings page's "Enable notifications" button is the one place we prompt.
 * Outcome is logged but not surfaced (no toast at login).
 */
export async function subscribeIfAlreadyPermitted(): Promise<void> {
  if (!(await isPushFeatureEnabled())) return;
  if (!supportsPush()) return;
  if (typeof Notification !== "undefined" && Notification.permission !== "granted") {
    return;
  }
  const outcome = await subscribeAndRegister();
  if (outcome.status !== "ok") {
    console.warn("[push] background re-subscribe failed:", outcome.status, "message" in outcome ? outcome.message : "");
  }
}

/** Shared: fetch VAPID key → subscribe the SW push manager → register with appserver. */
async function subscribeAndRegister(): Promise<PushOutcome> {
  // Fetch the VAPID public key. Empty string = appserver has no VAPID config
  // (dev/test) — skip subscription entirely.
  let vapidKey: string;
  try {
    const res = await px().query("space.roomy.push.getVapidPublicKey", {});
    vapidKey = res.publicKey;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn("[push] could not fetch VAPID public key:", e);
    return { status: "failed", message };
  }
  if (!vapidKey) return { status: "no-key" };

  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    console.debug("[push] serviceWorker.ready; existing subscription:", existing?.endpoint ?? "none");
    // Wrap subscribe in a timeout. Some Chromium builds (e.g. ungoogled forks
    // without Google FCM keys, or networks blocking the GCM channel on port
    // 5228) never resolve or reject `pushManager.subscribe()` — it just hangs.
    // Race against a 20s deadline so we fail gracefully with a clear status
    // instead of leaving the user with an infinite spinner.
    const subscribeP = reg.pushManager.subscribe({
      userVisibleOnly: true, // required by all browsers; we always show a notification
      applicationServerKey: base64UrlToUint8Array(vapidKey) as BufferSource,
    });
    const subscription =
      existing ??
      (await Promise.race([
        subscribeP,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("pushManager.subscribe timed out after 20s")),
            20_000,
          ),
        ),
      ]));
    console.debug("[push] pushManager.subscribe ok; endpoint:", subscription.endpoint);

    await registerPushSubscription(subscription);
    console.info("[push] registered subscription with appserver:", subscription.endpoint);
    localStorage.setItem(LAST_ENDPOINT_KEY, subscription.endpoint);
    return { status: "ok" };
  } catch (e) {
    // Stage-tag the error so the browser console pinpoints which step failed
    // (SW ready / subscribe / XRPC register). The message includes the error
    // name + message + any XRPC payload so a 401/400 is visible at a glance.
    const err = e as { name?: string; message?: string; statusCode?: number; payload?: unknown };
    const detail = `${err?.name ?? "Error"}${err?.statusCode ? ` (${err.statusCode})` : ""}: ${err?.message ?? String(e)}`;
    console.error("[push] subscription failed at subscribe/register:", detail, err?.payload ?? "");
    // Distinguish a timeout (from the race above) for a tailored toast.
    if (err?.message?.includes("timed out")) return { status: "timeout" };
    return { status: "failed", message: detail };
  }
}

/**
 * Unsubscribe this device on logout / "Disable on this device" so the
 * appserver stops delivering to it. Best-effort: a network failure here must
 * not block logout. Returns a {@link PushOutcome} so the settings page can
 * toast on the Disable button.
 */
export async function clearPushSubscription(): Promise<PushOutcome> {
  if (!supportsPush()) return { status: "unsupported" };
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
    return { status: "ok" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn("[push] clearPushSubscription failed:", e);
    return { status: "failed", message };
  }
}