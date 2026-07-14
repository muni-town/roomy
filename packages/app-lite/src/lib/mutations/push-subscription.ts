import { px } from "$lib/auth.svelte";

/**
 * Register the browser's `PushSubscription` with the appserver so push
 * notifications can be delivered to this device. Idempotent on endpoint:
 * re-registering (e.g. on each login) updates keys/expiry rather than
 * duplicating. The DOM `PushSubscription.toJSON()` types are pessimistic
 * (`endpoint: string | null`, `keys: … | null`), so we normalize to the
 * schema shape and fail loudly if a required field is missing — a real
 * subscription always has endpoint + keys.
 */
export async function registerPushSubscription(
  subscription: PushSubscription,
): Promise<void> {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error(
      "PushSubscription is missing required fields (endpoint/keys)",
    );
  }
  await px().procedure("space.roomy.push.registerSubscription", {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    // `expirationTime` is `number | null` (Firefox) or `number` (Chrome) or
    // absent; the schema accepts `number | null | undefined`.
    expirationTime: json.expirationTime,
  });
}

/**
 * Remove this device's subscription. Called on explicit unsubscribe (user
 * toggles notifications off) and on logout so the appserver stops delivering
 * to a device the user is signed out of. Idempotent.
 */
export async function unregisterPushSubscription(
  endpoint: string,
): Promise<void> {
  await px().procedure("space.roomy.push.unregisterSubscription", { endpoint });
}