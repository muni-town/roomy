# APNs Remote Push Plan (Native iOS)

**Date:** 2026-08-28
**Status:** Planned — not implemented
**Parent doc:** `packages/appserver/docs/plans/web-push-plan.md`

## Problem

The Tauri native apps (macOS + iOS) cannot use web push: WKWebView has no
service worker, `PushManager`, or `Notification` API, so `supportsPush()` in
`push.svelte.ts` correctly reports "unsupported". The current native path
(`src/lib/native-push.ts` + `tauri-plugin-notification`) shows notifications
**only while the app is running** — the WebSocket sync connection dies when
the app is backgrounded/suspended, so no notifications arrive when the app is
closed. Real remote push (APNs) is required for a shipping iOS experience.

## Current state (implemented 2026-08-28)

- `tauri-plugin-notification` 2.3.3 registered in `src-tauri` (Rust + JS +
  capability `notification:default`).
- `src/lib/native-push.ts` — permission + `sendNotification` bridge.
- `src/lib/sync.svelte.ts` — `notifyNativeForDiff` fires on `#messageDiff`
  `add` ops; `subscribeAllRoomTopics` + `watchRoomTopics` subscribe to every
  room topic (native builds only) so diffs arrive for rooms not being viewed.
- Verified: iOS simulator shows the system authorization prompt when a
  message arrives (SpringBoard logs: "Show notification user authorization
  prompt"). The one-time "Allow" click is interactive.

## What APNs requires

### 1. Apple Developer account + provisioning

- Paid Apple Developer Program membership ($99/yr).
- App ID with the **Push Notifications** capability enabled.
- An **APNs Auth Key** (`.p8`, key ID, team ID) — one key serves all apps.
- A **real device** for testing: simulators cannot receive APNs. Dev testing
  uses `xcrun simctl push` (simulated payloads) or a physical iPhone.

### 2. Tauri plugin choice

No official Tauri push plugin exists. Community options (all small/young —
dependency decision needs care):

| Plugin | Stars | Notes |
|---|---|---|
| `yanqianglu/tauri-plugin-mobile-push` | 10 | APNs + FCM, "no swizzling" |
| `spicavi/tauri-plugin-push-notifications` | 0 | APNs iOS, foreground-receive + tap events |
| `Choochmeque/tauri-plugin-notifications` | 78 | Desktop + mobile, most active |

The plugin must: register the device token with the appserver, surface
foreground-receive + tap events to JS, and handle the APNs entitlement in the
generated Xcode project.

### 3. Appserver changes

The current pipeline (`packages/appserver/src/push/`) is web-push-only:

- `webpush.ts` — VAPID + RFC 8291 `aes128g2` delivery to browser push-service
  endpoints (`https://fcm.googleapis.com/...` style). Native devices have no
  such endpoint.
- `dispatcher.ts` — `deliverPayload` POSTs to each subscription endpoint via
  `web-push`.

**Required changes:**

1. **Lexicon**: `space.roomy.push.registerSubscription` gains a `platform`
   field (`"web" | "ios" | "android"`). iOS registrations store the APNs
   device token instead of `{ endpoint, p256dh, auth }`. Schema change in
   `packages/sdk/src/schemas/procedures/registerPushSubscription.ts` +
   `packages/appserver/src/handlers/space.roomy.push.registerSubscription.ts`
   + `push_subscriptions` table (readstate DB migration).
2. **APNs sender**: new module (e.g. `src/push/apns.ts`) using HTTP/2 + JWT
   (e.g. `@parse/node-apn` or raw `http2` + `jsonwebtoken`). Env:
   `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_AUTH_KEY` (`.p8`), `APNS_TOPIC`
   (`space.roomy`), `APNS_ENVIRONMENT` (`sandbox`/`production`).
3. **Dispatcher routing**: `deliverPayload` branches on subscription
   platform — web → `web-push`, iOS → APNs. The existing per-subscription
   failure isolation (404/410 → prune) maps to APNs `BadDeviceToken` /
   `Unregistered` responses.
4. **Payload**: APNs accepts a JSON `aps` dict (`alert`, `sound`, `badge`,
   `thread-id`). Map `PushPayload` → `aps`; keep the same no-message-body
   privacy stance (counts + room/sender names only).

### 4. Client changes

- `native-push.ts` gains a token-registration path: on app launch, ask the
  plugin for the APNs device token, POST it via
  `space.roomy.push.registerSubscription` with `platform: "ios"`.
- Foreground-receive: the plugin's `onNotificationReceived` → show the
  notification via `tauri-plugin-notification` (the app is foreground, so
  the OS would otherwise suppress it).
- Tap handling: `onAction` → navigate to `/[space]/[room]` (the `extra`
  payload already carries `spaceId`/`roomId`).

### 5. macOS

macOS supports APNs for regular apps, but no Tauri plugin covers it — custom
Swift would be required. **Defer**: the sync-connection notifications (option
A) cover the desktop case while the app is open; macOS remote push is
lowest priority.

## Rollout order

1. Apple account + App ID + APNs key + physical device.
2. Pick the Tauri plugin; wire token registration + foreground receive.
3. Appserver: lexicon `platform` field + `apns.ts` sender + dispatcher
   routing (web path untouched — no regression).
4. Test with `xcrun simctl push` (simulated) then a real device.
5. macOS: revisit only if desktop remote push becomes a requirement.

## Open questions

- Which community plugin to adopt (maintenance risk).
- Whether the appserver should also support Android FCM in the same
  `platform`-routed sender (the dispatcher design generalizes).
- Badge handling: the web-push payload carries counts; APNs `badge` needs
  per-user unread totals from the readstate DB.
