import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

/**
 * Query for the appserver's VAPID public key. The browser needs this to call
 * `pushManager.subscribe({ applicationServerKey })`. An empty/null key means
 * push isn't configured on the appserver (dev/test) — callers should treat
 * that as "push unavailable" and skip subscription.
 *
 * Unauthenticated-safe: the appserver serves this without a session, but we
 * still gate it on `px()` being available (i.e. the user is logged in) since
 * push is only useful once we can register the subscription for that user.
 */
export function createVapidPublicKeyQuery() {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.push.getVapidPublicKey"),
    queryFn: () => px().query("space.roomy.push.getVapidPublicKey", {}),
  }));
}