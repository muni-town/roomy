# Native Push Transports Plan

**Date:** 2026-09-28
**Status:** Seam implemented; native transports not built
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

`apn.ts`, `fcm.ts` and `sse.ts` are draft registrations: they answer `skipped`
for every row, so a device stored against a transport that has not shipped is
counted and left in place. They must not answer `gone` — that prunes the row,
and an unbuilt transport would then unregister a device for a reason unrelated
to the device.

The stored discriminator is `push_subscriptions.kind`
(`src/db/readStateSchema.sql`, read-state schema v12 in
`src/db/readStateVersions.ts`). It defaults to `'webpush'`, so every existing
row routing is unchanged. `upsertSubscription`/`selectSubscriptions`
(`src/queries/pushSubscriptions.ts`) carry it.

`space.roomy.admin.push.testSend` (`src/handlers/space.roomy.admin.push.testSend.ts`)
also delivers through the seam, so a native device is diagnosable by the same
endpoint that diagnoses a browser.

## Transports to build

| Kind | Platform | Service endpoint | Credential |
|------|----------|------------------|------------|
| `webpush` | Browsers (Chrome/Firefox/Edge/Safari) | per-subscription push-service URL | VAPID keypair + `p256dh`/`auth` (RFC 8291) |
| `apns` | iOS / iPadOS / macOS | `api.push.apple.com` | APNs auth key (`.p8`, ES256) + team/key id, per-app topic |
| `fcm` | Android (and Chrome, if not going through Web Push) | `fcm.googleapis.com` | Service-account JSON (HTTP v1 OAuth) |

APNs and FCM are named in `PushTransportKind` already. A stored row that names a
kind with no registered transport is counted as a failure (`statsFailed`) and
logged, and the row is left in place — a rollout gap is visible rather than a
silently dropped push.

### APNs

APNs wants an HTTP/2 POST to `/3/device/<token>` with a provider JWT
(`Authorization: bearer <jwt>`, signed ES256 with the `.p8` key),
`apns-topic` = the app bundle id, `apns-push-type` (`alert`/`background`),
`apns-priority`, and `apns-collapse-id` for coalescing — which is where
`PushDeliveryOptions.topic` maps. A `{"type":"message","spaceId":…,"roomId":…}`
payload identical to the Web Push body can be sent as an APS dictionary, so the
client's notification-decoding logic is shared. `410 Unregistered` and
`400 BadDeviceToken` map to `gone` (prune); `429`/`5xx`/network map to `retry`.

### FCM

FCM HTTP v1 POSTs to `https://fcm.googleapis.com/v1/projects/<project>/messages:send`
with an OAuth2 bearer token from a service-account JSON. `collapse_key` maps
from `topic`; the same JSON body is carried in the `data` field. `UNREGISTERED`
/ `NOT_FOUND` map to `gone`; `UNAVAILABLE`/`INTERNAL` map to `retry`.

Both native transports share the JSON payload contract already defined by
`PushPayload` (`src/push/types.ts`) — the seam passes `body` as a string, so a
native transport forwards the same bytes. No wire payload change is required to
add them.

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

Option 1 is preferred: the row is the same concept, and the handler already
owns per-field validation. This is a client-visible wire change, so it belongs
in its own change, not with the seam.

### Client side (`packages/app-lite`)

`src/lib/push.svelte.ts` drives the browser's `PushManager`, which an installed
native app does not have. The Tauri shell (`src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`) has no push plugin today, and Tauri's official
`notification` plugin only posts *local* notifications — it does not obtain an
APNs/FCM registration token. Remote push needs a plugin that bridges to the
platform APIs (`registerForRemoteNotifications` / `FirebaseMessaging`, e.g. a
community `tauri-plugin-*` push plugin, or a small in-repo Rust command) and
surfaces the token to web code; a native client then registers that token
through the same XRPC call with `kind: "apns"`/`"fcm"`. The subscription
lifecycle (register on login, unregister on logout, re-register on token
rotation) mirrors the existing `ensurePushSubscription`/`clearPushSubscription`
and the `push-subscription-changed` handler in `push.svelte.ts` — token rotation
is the native analogue of endpoint rotation, which
`installPushSubscriptionChangeListener` already handles for browsers.

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

Web Push reads VAPID keys from env in `src/push/transports/webPush.ts`. APNs/FCM read
their own credentials the same way (an APNs `.p8` + key/team id, an FCM
service-account JSON), each transport owning its own configuration. The
appserver must boot with any subset configured; a transport whose credentials
are absent delivers nothing, exactly as `sendPush` skips when VAPID is unset.

## Open questions

- **Which native targets, and which first?** iOS forces APNs; if the native
  client is Android-first, FCM is the smaller first transport.
- **Per-transport rate/coalescing budgets.** Native services have their own
  quotas; the dispatcher's single `CONCURRENCY` may need a per-transport
  ceiling.
- **Notification-service extensions.** iOS needs a Notification Service
  Extension to decrypt/reshape content; the payload must stay within APNs'
  size limits (4 KB), which the existing `PushPayload` already respects.
- **Token validity windows.** APNs tokens can be invalidated on reinstall;
  `410` pruning covers it, but a periodic token-revalidation sweep may be
  warranted.
