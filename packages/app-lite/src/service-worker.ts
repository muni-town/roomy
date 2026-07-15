/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="WebWorker" />

declare let self: ServiceWorkerGlobalScope;

import { build, files, version } from "$service-worker";

// Create a unique cache name for this deployment
const CACHE = `cache-${version}`;

const ASSETS = [
  ...build, // the app itself
  ...files, // everything in `static`
];

self.addEventListener("install", (event) => {
  // Create a new cache and add all files to it
  async function addFilesToCache() {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
  }

  event.waitUntil(addFilesToCache());
});

self.addEventListener("activate", (event) => {
  // Remove previous cached data from disk
  async function deleteOldCaches() {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
  }

  event.waitUntil(deleteOldCaches());
});

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  // ignore POST requests etc
  if (event.request.method !== "GET") return;
  // ignore oauth pages
  if (url.pathname.startsWith("/oauth")) return;

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

interface PushPayload {
  type: "message" | "digest";
  spaceId?: string;
  roomId?: string;
  messageId?: string;
  count?: number;
  roomName?: string;
  authorName?: string;
  /** Decoded message text content (first ~120 chars). */
  messageContent?: string;
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
  const count = payload?.count ?? 1;
  const room = payload?.roomName ?? "a room";
  const title =
    payload?.type === "digest"
      ? `${count} new messages in ${room}`
      : payload?.authorName
        ? `${payload.authorName} in ${room}`
        : `New message in ${room}`;
  const body =
    payload?.type === "digest"
      ? `${count} new messages`
      : payload?.messageContent
        ? payload.messageContent
        : payload?.authorName
          ? `${payload.authorName} sent a message`
          : "New message";

  // Stash the deep-link target on the notification so `notificationclick`
  // can route into the right room. Tag = roomId so a room's notifications
  // replace each other (the appserver also sets `topic: room:<roomId>` for
  // the same coalescing at the push-service level).
  const roomId = payload?.roomId ?? "";
  const spaceId = payload?.spaceId ?? "";
  const data = { spaceId, roomId };
  const tag = roomId ? `room:${roomId}` : undefined;

  await self.registration.showNotification(title, {
    body,
    tag,
    data,
    // Sender avatar (message) or room/space avatar (digest), resolved to a
    // public CDN URL by the appserver. The OS fetches the image itself; if the
    // URL is unreachable the notification simply shows without an icon.
    ...(payload?.icon ? { icon: payload.icon } : {}),
    // Phase 1: no badge yet. Phase polish can add a monochrome maskable badge.
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
  const { spaceId, roomId } = (event.notification.data ?? {}) as {
    spaceId?: string;
    roomId?: string;
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
      target.postMessage({ type: "navigate", spaceId, roomId });
    }
    return;
  }

  // No existing tab — open one at the room route (or root as fallback).
  const path =
    spaceId && roomId ? `/space/${spaceId}/${roomId}` : "/";
  await self.clients.openWindow(path);
}
