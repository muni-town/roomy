/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="WebWorker" />

declare let self: ServiceWorkerGlobalScope;

import { build, files, version } from "$service-worker";
import { notificationText, type PushNotificationView } from "./lib/notificationText";

// Create a unique cache name for this deployment
const CACHE = `cache-${version}`;

// The service worker must NOT cache its own file — otherwise the browser's
// update check (a fetch of `/service-worker.js`) is intercepted by the old
// SW's fetch handler, which serves the stale copy from cache, and the SW
// never updates. Filter it out of the build/files asset lists.
const SW_PATH = "/service-worker.js";
const ASSETS = [
  ...build.filter((p) => p !== SW_PATH),
  ...files.filter((p) => p !== SW_PATH),
];

// ── Web Push: VAPID key cache for resubscription ─────────────────────────
// The page posts the appserver's VAPID public key to the SW after each
// successful subscribe (message type "push-vapid-key"). The SW caches it so
// `pushsubscriptionchange` (which fires with no page open) can resubscribe
// without calling the authenticated XRPC endpoint — which the SW cannot do.
// Without this, a rotated endpoint (Chrome/FCM does this periodically) is
// never re-registered until the user next logs in.
let cachedVapidKey: string | null = null;

// (VAPID key message handling is merged into the main message listener below.)

self.addEventListener("install", (event) => {
  // Take over immediately so the new SW activates without waiting for all
  // existing tabs to close.
  self.skipWaiting();

  // In dev, skip caching — the SW self-unregisters on activate anyway.
  if (build.length === 0) return;

  // Create a new cache and add all files to it
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
  })());
});

self.addEventListener("activate", (event) => {
  async function activate() {
    // In dev mode, unregister the SW entirely and wipe all caches. A
    // prod-caching SW registered against this origin would otherwise keep
    // intercepting Vite's module requests with its network-first fetch handler,
    // turning transient errors into permanent 404s. The browser re-registers
    // the SW on the next page load (SvelteKit's auto-registration), and the
    // new SW also self-unregisters in dev.
    if (build.length === 0) {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
      await self.clients.claim();
      return;
    }

    // Remove previous cached data from disk
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    // Claim all open clients so the new SW controls existing tabs
    // immediately, not just future navigations.
    await self.clients.claim();
  }

  event.waitUntil(activate());
});

// Allow the page to trigger an immediate update by posting
// { type: "SKIP_WAITING" }. SvelteKit's built-in registration can also
// listen for a waiting SW and prompt the user; this handler makes
// `skipWaiting` available on demand from the client side.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "push-vapid-key" && typeof event.data.key === "string") {
    cachedVapidKey = event.data.key;
  }
});

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  // ignore POST requests etc
  if (event.request.method !== "GET") return;
  // ignore oauth pages
  if (url.pathname.startsWith("/oauth")) return;
  // Never intercept the service worker's own file — the browser must always
  // fetch it from the network to detect updates. Caching/serving it here
  // would freeze the SW at its current version forever.
  if (url.pathname === SW_PATH) return;

  // In dev mode the `build` manifest is empty (SvelteKit only populates it at
  // build time). Skip all fetch interception so Vite's dev server owns module
  // serving, HMR, and dynamic imports. Without this the SW's network-first
  // handler intercepts Vite's module requests (e.g.
  // /.svelte-kit/generated/client/nodes/2.js?t=…), and any transient dev
  // server error cascades into a permanent 404 (the SW returns
  // `new Response(undefined, { status: 404 })` on cache miss), breaking
  // client-side navigation to any route that loads a new node bundle.
  if (build.length === 0) return;

  async function respond() {
    const cache = await caches.open(CACHE);

    // `build`/`files` can always be served from the cache
    if (ASSETS.includes(url.pathname)) {
      return cache.match(url.pathname);
    }

    // for everything else on our domain, try the network first, but fall back to the cache if we're
    // offline.
    try {
      const response = await fetch(event.request);

      if (response.status === 200 && globalThis.location.host == url.host) {
        cache.put(event.request, response.clone());
      }

      return response;
    } catch (e) {
      if (globalThis.location.host == url.host) {
        return cache.match(event.request);
      } else {
        throw e;
      }
    }
  }

  event.respondWith(
    (async () => {
      const resp = await respond();
      return resp ? resp : new Response(undefined, { status: 404 });
    })(),
  );
});

// ── Web Push ────────────────────────────────────────────────────────────
//
// The appserver encrypts each push payload (RFC 8291 `aes128g2`) and POSTs it
// to the browser's push-service endpoint; the browser decrypts and hands us
// the plaintext JSON here. The payload carries counts + room/sender names
// only — never message content (see packages/appserver/src/push/types.ts) —
// so we build the visible notification from those fields.
//
// `event.notification` is unavailable in a `push` event (it only exists for
// `notificationclick`), so we read the payload from `event.data`.

interface PushPayload extends PushNotificationView {
  spaceId?: string;
  roomId?: string;
  messageId?: string;
  /** Browser-fetchable avatar URL (sender for messages, room/space for digests). */
  icon?: string;
}

self.addEventListener("push", (event: PushEvent) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event: PushEvent): Promise<void> {
  let payload: PushPayload | null = null;
  try {
    const text = event.data?.text();
    payload = text ? (JSON.parse(text) as PushPayload) : null;
  } catch {
    // Malformed/empty payload: show a generic fallback so the push still
    // satisfies `userVisibleOnly: true` (a push with no visible notification
    // would otherwise be silently dropped / flagged by the browser).
    payload = null;
  }
  // Title/body come from the shared renderer (see lib/notificationText.ts):
  // authorName when resolved, else the author DID — "New message" only when
  // the payload has no author at all.
  const { title, body } = notificationText(payload ?? {});

  // Stash the deep-link target on the notification so `notificationclick`
  // can route into the right room. Tag = roomId so a room's notifications
  // replace each other (the appserver also sets `topic: room:<roomId>` for
  // the same coalescing at the push-service level).
  const roomId = payload?.roomId ?? "";
  const spaceId = payload?.spaceId ?? "";
  // Include the message id so a notification click can deep-link to and
  // highlight the exact message (route `?message=<id>`). Digests carry no
  // single message id — they land at the room's bottom.
  const data = {
    spaceId,
    roomId,
    ...(payload?.messageId ? { messageId: payload.messageId } : {}),
  };
  const tag = roomId ? `room:${roomId}` : undefined;

  await self.registration.showNotification(title, {
    body,
    tag,
    data,
    // Sender avatar (message) or room/space avatar (digest), resolved to a
    // public CDN URL by the appserver. The OS fetches the image itself; if the
    // URL is unreachable the notification simply shows without an icon.
    ...(payload?.icon ? { icon: payload.icon } : {}),
    // No badge is shown for a push; a monochrome maskable badge would go here.
  });
}

// Clicking a notification focuses an existing app tab (or opens one) and
// navigates it into the notifying room. The route lives under the spaces
// tree; if the app doesn't yet have a per-room route we fall back to the app
// root so the click still does something useful.
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.waitUntil(handleNotificationClick(event));
});

async function handleNotificationClick(
  event: NotificationEvent,
): Promise<void> {
  event.notification.close();
  const { spaceId, roomId, messageId } = (event.notification.data ?? {}) as {
    spaceId?: string;
    roomId?: string;
    messageId?: string;
  };

  // Focus an existing tab if one is open.
  const allClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const target = allClients.find(
    (c) => c.url.includes(self.location.origin),
  );
  if (target) {
    target.focus();
    if (spaceId && roomId) {
      target.postMessage({ type: "navigate", spaceId, roomId, messageId });
    }
    return;
  }

  // No existing tab — open one at the room route (or root as fallback).
  // `?message=<id>` deep-links to and highlights the exact message.
  const query = messageId ? `?message=${encodeURIComponent(messageId)}` : "";
  const path =
    spaceId && roomId ? `/${spaceId}/${roomId}${query}` : "/";
  await self.clients.openWindow(path);
}

// ── Push subscription rotation ───────────────────────────────────────────
//
// Chrome/FCM periodically expires and reissues push subscription endpoints
// (Firefox's autopush and Safari's APNs do this far less often). The spec
// event for this is `pushsubscriptionchange`, fired with the dead
// subscription and expecting the SW to call `pushManager.subscribe()` again
// and report the new endpoint to the appserver.
//
// The SW cannot call the authenticated XRPC endpoint itself, so it does the
// only thing it can: resubscribe (using the cached VAPID key) and post the
// new subscription to any open page client, which re-registers it. If no
// page is open, the new endpoint is reported on the next login via
// `subscribeIfAlreadyPermitted()` in auth.svelte.ts — the replaced endpoint is
// 410-pruned by the appserver in the meantime, so the user sees a brief gap
// rather than a silent permanent loss.
//
// Note: Chrome's firing of this event is unreliable (crbug 407523313), so the
// login-time re-subscribe is the load-bearing recovery path; this handler
// covers Firefox/Safari and any Chrome build that does fire it.

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handlePushSubscriptionChange(event));
});

async function handlePushSubscriptionChange(event: PushSubscriptionChangeEvent): Promise<void> {
  // Unsubscribe the dead subscription if the browser hasn't already.
  try {
    await event.oldSubscription?.unsubscribe();
  } catch {
    // Already gone — fine.
  }

  if (!cachedVapidKey) {
    // No VAPID key cached yet (the page hasn't subscribed since this SW
    // activated). Can't resubscribe without it; the next login will.
    console.warn("[sw] pushsubscriptionchange with no cached VAPID key — deferring to login re-subscribe");
    return;
  }

  let newSubscription: PushSubscription;
  try {
    newSubscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(cachedVapidKey),
    });
  } catch (e) {
    console.warn("[sw] resubscribe on pushsubscriptionchange failed:", e);
    return;
  }

  // Hand the new subscription to any open page so it can register it with
  // the appserver (the SW has no auth to do so itself). Post the JSON shape
  // (not the live PushSubscription, which isn't cloneable across postMessage).
  const json = newSubscription.toJSON();
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const payload = {
    type: "push-subscription-changed",
    subscription: {
      endpoint: json.endpoint,
      keys: json.keys,
      expirationTime: json.expirationTime,
    },
  };
  await Promise.all(clients.map((c) => c.postMessage(payload)));
}

/** base64url → Uint8Array (for the VAPID `applicationServerKey`). Mirrors the
 *  helper in push.svelte.ts — duplicated because the SW can't import $lib. */
function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
