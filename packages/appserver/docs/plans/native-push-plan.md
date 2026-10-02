# Native Push Transports Plan

**Date:** 2026-09-28
**Status:** Implemented — APNs, FCM, registration contract, Tauri wiring
**Related:** `web-push-plan.md` (the Web Push pipeline this extends)

## Problem

Push delivery today is Web Push only. Everything upstream of the outbound call —
recipient enumeration, preferences, digests, freshness, per-room coalescing,
pruning, failure accounting — is transport-agnostic already
(`src/push/dispatcher.ts`, `src/push/evaluate.ts`); the transport itself was the
one part welded in. `deliverPayload` called `sendPush` directly.

A mobile app cannot use Web Push on iOS: an installed app receives pushes
through APNs, not through a browser push service, and the browser `PushManager`
that `src/lib/push.svelte.ts` drives is not the mechanism available to a
native shell. Android and desktop-native builds likewise route through FCM or
APNs rather than the browser's endpoint.

The `src/push/transports/types.ts` seam is now in place so a second transport can be
added without touching any delivery policy.

## The seam (implemented)

`PUSH_TRANSPORTS` (`src/push/transports/types.ts`) is a registry keyed by the `kind` a
stored subscription carries. A transport implements `PushTransport`:

```ts
deliver(target: PushTarget, body: string, options: PushDeliveryOptions): Promise<PushOutcome>
```

- `PushTarget` is a stored subscription as a transport sees it: `kind`,
  `endpoint`, optional `p256dh`/`auth`, `expirationTime`. `endpoint` is the
  opaque destination — a push-service URL for Web Push, a device token for a
  native transport; the credentials are transport-specific.
- `PushOutcome` is one vocabulary for every transport: `delivered`
  (`status: number | null`), `gone` (`status: number | null`), `skipped`
  (`status: number | null`), or `retry` (`error`). A transport never throws.
  `skipped` is "nothing was attempted" (unconfigured, or a device this
  transport cannot reach); it is counted apart from `delivered` so an
  unconfigured pipeline never reads as a healthy one.
- `PushTransport.isConfigured()` reports whether the transport could deliver on
  this appserver right now. Diagnostics only — delivery does not consult it,
  because the `skipped` outcome already answers the same question per row.
- `PushDeliveryOptions` (`topic`, `urgency`, `ttl`) are the transport-neutral
  delivery hints. Each transport maps them onto its own wire controls — Web Push
  `Topic`/`Urgency`/`TTL`; APNs `apns-collapse-id`; FCM `collapse_key`.

`webPushTransport` (`src/push/transports/webPush.ts`) is the first implementation; it wraps
the existing `sendPush` and registers itself in `PUSH_TRANSPORTS.webpush` at
module load. `deliverPayload` (`src/push/dispatcher.ts`) looks up
`PUSH_TRANSPORTS[sub.kind]` and keeps every policy decision: it prunes on
`gone`, counts on `delivered`/`skipped`/`retry`, and logs per transport.

`apn.ts` and `fcm.ts` are implemented; `sse.ts` remains a draft registration
that answers `skipped` for every row, so a device stored against a transport
that has not shipped is counted and left in place. A draft must not answer
`gone` — that prunes the row, and an unbuilt transport would then unregister a
device for a reason unrelated to the device.

The stored discriminator is `push_subscriptions.kind`
(`src/db/readStateSchema.sql`, read-state schema v12 in
`src/db/readStateVersions.ts`). It defaults to `'webpush'`, so every existing
row routing is unchanged. `upsertSubscription`/`selectSubscriptions`
(`src/queries/pushSubscriptions.ts`) carry it.

`space.roomy.admin.push.testSend` (`src/handlers/space.roomy.admin.push.testSend.ts`)
also delivers through the seam, so a native device is diagnosable by the same
endpoint that diagnoses a browser.

## Transports

| Kind | Platform | Service endpoint | Credential |
|------|----------|------------------|------------|
| `webpush` | Browsers (Chrome/Firefox/Edge/Safari) | per-subscription push-service URL | VAPID keypair + `p256dh`/`auth` (RFC 8291) |
| `apns` | iOS / iPadOS / macOS | `api.push.apple.com` (or `api.sandbox.push.apple.com`) | APNs auth key (`.p8`, ES256) + key/team id, per-app topic |
| `fcm` | Android | `fcm.googleapis.com` | Service-account JSON (HTTP v1 OAuth) |
| `sse` | — | — | draft; not built |

A stored row naming a kind with no registered transport is counted as a failure
(`statsFailed`) and logged, and the row is left in place — a rollout gap is
visible rather than a silently dropped push.

### APNs (`src/push/transports/apn.ts`)

An HTTP/2 POST to `/3/device/<token>` with a provider JWT
(`authorization: bearer <jwt>`, ES256 over the `.p8` key, `kid`/`iss` for the
key and team id), `apns-topic` = the app bundle id, `apns-push-type: alert`,
`apns-priority: 10`, and `apns-collapse-id` from
`PushDeliveryOptions.topic`. The session and the provider token are both cached
— Apple rate-limits token refreshes to one per 20 minutes — and a refused
token is dropped so the next attempt mints a fresh one.

The alert text is built at send time rather than left to the client: iOS
displays `aps.alert` with no app running, so a payload carrying only ids would
arrive blank. `notificationText` (`@roomy-space/sdk/push`, the renderer the
service worker also uses) supplies the same title/body a browser push shows,
and the raw payload rides along as a top-level `roomy` key for deep-linking.
That key is a JSON **string**, not a nested object — see "Payload shape" below.

`410` (any reason) and `400 BadDeviceToken`/`DeviceTokenNotForTopic` map to
`gone` (prune). `429`/`5xx`/network map to `retry`. A `400` the transport
caused itself is also `retry`, never `gone`: pruning a healthy device would
silently unsubscribe a user because we built a bad request.

### FCM (`src/push/transports/fcm.ts`)

An HTTP v1 POST to
`https://fcm.googleapis.com/v1/projects/<project>/messages:send` with an OAuth2
bearer token: an RS256 assertion to Google's token endpoint (scope
`…/auth/firebase.messaging`, no `sub` — that is reserved for domain-wide
delegation), cached until just before it expires. `collapse_key` carries
`topic`, in the Android config rather than `data` (a reserved key there is
overridden). `UNREGISTERED`/`NOT_FOUND` map to `gone`;
`QUOTA_EXCEEDED`/`UNAVAILABLE`/`INTERNAL` (429/503/500) map to `retry`; a
refused bearer token is dropped so the next attempt re-exchanges.

FCM carries the visible text in `notification` for the same reason APNs does —
Android does not display a data-only message unless the app is running to
handle it — with the same JSON payload string under `data.roomy`.

Both transports take their configuration as a constructed argument
(`createApnsTransport`/`createFcmTransport`) rather than reading
`process.env` at import, so a test drives them against a local server and
asserts the wire request. Each maps a hint (`PushDeliveryOptions.topic`,
`urgency`, `ttl`) onto its own controls; no delivery policy is duplicated.

### Payload shape

Both native transports forward the same `PushPayload`
(`src/push/types.ts`) the Web Push transport sends, as a JSON string, and add
the visible title/body. The payload is a string rather than a nested object
because the client plugin projects a native notification to JS by copying only
String and NSNumber values — a dictionary is dropped before the webview sees
it. On APNs a custom key must also be a peer of `aps`, never a child: Apple
ignores unknown keys inside `aps`.

## Device-token registration

The appserver needs a device token per installed app instance, the analogue of
the browser's `PushSubscription` endpoint. A native client obtains it from the
platform (APNs `didRegisterForRemoteNotificationsWithDeviceToken`; FCM
`onNewToken`) and registers it like a browser registers its endpoint. It is
stored in `push_subscriptions` with `kind` set to the transport, the token in
`endpoint`, and `p256dh`/`auth` left empty.

### Existing lexicons: no breaking change

`space.roomy.push.registerSubscription` (`packages/sdk/src/schemas/lexicons/space.roomy.push.registerSubscription.json`)
currently requires `endpoint` + `keys.{p256dh,auth}` — a browser
`PushSubscription`. A native registration carries a token and no `keys`. Two
options, in preference order:

1. **Add an optional `kind` to the existing input and relax `keys`.**
   `kind` defaults to `webpush`; `keys` becomes optional, required only when
   `kind` is `webpush` (validated in
   `src/handlers/space.roomy.push.registerSubscription.ts`, which already does
   field validation by hand). One client path, one stored row shape, no new
   NSID. `unregisterSubscription` keys on `endpoint`, which is already unique
   per device, so it needs no change.

2. **A sibling procedure** (e.g. `space.roomy.push.registerDevice`) that writes
   the same table with a native `kind`. Keeps the browser input strictly
   typed, at the cost of a second registration path and a second lexicon to
   maintain.

Option 1 was taken: the row is the same concept, and the handler already owns
per-field validation. The schema stays one flat object with an optional `kind`
and an optional `keys` (rather than a kind-discriminated union) because the
lexicon generator converts a single object shape, and the wire contract has to
stay expressible as an atproto lexicon; the pairing is enforced in the handler.

### Client side (`packages/app-lite`)

`src/lib/native-push.ts` is the native equivalent of `push.svelte.ts`'s Web
Push path, over `tauri-plugin-mobile-push` (Rust) +
`tauri-plugin-mobile-push-api` (JS). `push.svelte.ts` stays the single entry
point the rest of the app calls — `ensurePushSubscription`,
`subscribeIfAlreadyPermitted`, `clearPushSubscription` — and dispatches to the
native path when `window.__TAURI__.os.platform()` reports `ios`/`android`, so
callers do not branch. Every plugin import is dynamic, so the web bundle never
evaluates it. A registered token is remembered in localStorage
(`roomy.push.lastNativeToken`), the native analogue of the browser's endpoint.

**The plugin's 0.1.4 limitations are load-bearing here:**

- On **Android**, `requestPermission()` and `getToken()` cannot work: the crate
  registers Rust `#[tauri::command]` handlers, and Tauri dispatches those
  before the native Kotlin plugin, so the non-iOS stub arms always win
  (`{granted: false}`, `""`). `ensureNativeSubscription` therefore requires an
  explicit `granted === true` and rejects an empty token with a message naming
  Android as unsupported, rather than registering an endpoint that could never
  be delivered to.
- The three event listeners (`onTokenRefresh`, `onNotificationReceived`,
  `onNotificationTapped`) are **non-functional in 0.1.4 on both platforms**:
  `register_listener` is shadowed by the same Rust no-op on Android, and on iOS
  the plugin's own README states `trigger()` cannot reach the webview. They are
  installed (they register cleanly and will start working if upstream fixes
  this) but nothing may depend on tap-through. Tapping a native notification is
  therefore not routed by this plugin version.
- **iOS** `requestPermission()`/`getToken()` do work (direct `@_cdecl` FFI), so
  the iOS registration path is real: the hex APNs device token is registered
  with `kind: "apns"`.

Replacing the plugin, or upgrading past a release that fixes Android dispatch,
changes only `native-push.ts`: the registration contract and the appserver
transports do not.

Preferences, digests and recipient selection are untouched: they live in
`evaluate.ts`/`dispatcher.ts` and are already transport-agnostic, so a native
device receives the same pushes under the same preference rules as a browser.

## What stays server-side

- Recipient enumeration, read-access filtering, mention/reply routing
  (`src/push/evaluate.ts`).
- Preferences (per-space override → user default → `engaged`) and the Engaged
  digest batch/threshold logic (`src/push/dispatcher.ts`,
  `src/queries/notificationState.ts`).
- Freshness gating (`src/push/freshness.ts`).
- Pruning, coalescing topic derivation, and failure accounting
  (`src/push/dispatcher.ts`).

None of these learn about a transport; they see a `PushTarget` and a
`PushOutcome`.

## Secrets & configuration

Web Push reads VAPID keys from env in `src/push/transports/webPush.ts`. APNs
reads `APNS_AUTH_KEY` (the `.p8`, PEM or base64-encoded PEM), `APNS_KEY_ID`,
`APNS_TEAM_ID`, `APNS_TOPIC` and `APNS_ENVIRONMENT`; FCM reads
`FCM_SERVICE_ACCOUNT` (the service-account JSON as one line). Each transport
owns its own configuration and reports whether it is usable via
`isConfigured()`, surfaced in `space.roomy.admin.push.getStats`. The appserver
boots with any subset configured: a transport whose credentials are absent
reports every delivery as `skipped` rather than failing, exactly as `sendPush`
does when VAPID is unset.

The Android build additionally needs `google-services.json`, supplied in CI
from the `GOOGLE_SERVICES_JSON` repository secret. The iOS build needs the
`aps-environment` entitlement written into the generated Xcode project (the
Tauri CLI emits that file empty, and has no config field for iOS
entitlements), which the release workflow does after `ios init`; the App ID
must have Push Notifications enabled and the provisioning profile regenerated
so the entitlement is in its allowlist.

## Open questions

- **Android dispatch in the plugin.** 0.1.4's Android commands are shadowed by
  the crate's own Rust stubs (see "Client side"), so no Android device can
  obtain a token. Either upstream fixes the dispatch order, or the Android
  token path moves into this repo's own Tauri command.
- **Notification tap-through.** No native notification routes into a room
  today, for the same reason. The client's routing code exists and is inert.
- **Per-transport rate/coalescing budgets.** Native services have their own
  quotas; the dispatcher's single `CONCURRENCY` may need a per-transport
  ceiling.
- **Notification-service extensions.** iOS needs a Notification Service
  Extension to decrypt/reshape content. The alert text is built server-side
  today (see "Payload shape"), and the payload stays within APNs' 4 KB limit,
  which `PushPayload` already respects.
- **Token validity windows.** APNs tokens can be invalidated on reinstall;
  `410`/`BadDeviceToken` pruning covers it, but a periodic token-revalidation
  sweep may be warranted.
- **Badge counts.** APNs `aps.badge` needs per-user unread totals from the
  read-state DB; the payload carries a `count` but no badge is sent.
