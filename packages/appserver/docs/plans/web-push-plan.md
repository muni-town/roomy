# Web Push Notifications Plan

**Date:** 2026-07-14
**Status:** Implemented (rebased onto main@26de4e5a)
**Parent doc:** `appserver-architecture.md`

## Problem

We want to offer web push notifications for Roomy spaces, on the user's terms. The
user-facing copy introduces four "update rhythms":

| Level | Behaviour |
|-------|-----------|
| ❌ **Silent** | No notifications. |
| 🍃 **Quiet** | Silent except mentions; some users can nudge you. |
| 💌 **Engaged** | All mentions, plus occasional prompts for missed conversations. |
| 👀 **Busy** | All new messages for spaces you're in. |

To start, **the same four options are reused verbatim** in two places: the per-space
join flow and the per-space notification settings. There is no finer customisation yet —
a per-space override plus a user-wide default is the whole preference model.

The specific, detailed behaviour we are committing to first is the **Engaged "occasional
prompts"** digest:

> Initially only fire for **rooms you have sent a message in**, where there are **new
> messages you haven't seen**. Only **one push per room** for those new messages **until
> you open the room again**. Trigger = whichever happens first of **5+ new unseen
> messages** or **1 hour elapsed since the first new unseen message**.

This document is the implementation plan for both the appserver and the `app-lite`
frontend.

## MVP scope

In scope for the first implementation:

1. Web Push plumbing end-to-end (VAPID, service worker, subscription storage, delivery).
2. Preference model: user default + per-space override, the four levels, set during join
   and in settings.
3. **Engaged digest** — the detailed trigger above. This is the primary deliverable.
4. **Busy** — push on every new message in readable rooms of spaces you're in (with
   burst-coalescing, see below).
5. Subscription management UI (`/user/settings/notifications`) + a shared "Choose your
   update rhythm" component used in both the join flow and per-space settings.

Explicitly deferred (flagged in copy but not built in the first pass):

- **Quiet "nudge"** — the ability for another user to nudge you. This is a separate user
  action and a separate push path; design it later.
- **Quiet / Engaged mentions** — require a mention representation that does not yet
  exist in the event schema (see §Mention detection). We will land the plumbing and the
  preference routing, and wire mentions as soon as the mention extension exists. Until
  then Quiet behaves like Silent and Engaged behaves like "digest-only".
- Per-room overrides, granular mute, do-not-disturb schedules.

## Architecture overview

```
app-lite (browser)
  Service Worker ── Push API ──> browser push service
     ▲ push events (notification display + click → open room)
     │
  PushSubscription (endpoint + keys) ── registerSubscription (XRPC, PDS-proxied) ──┐
  preference chooser (join flow + settings) ── setPreferences (XRPC) ─────────────┐ │
                                                                                  │ │
appserver (Bun)                                                                   ▼ │
  ┌─ push handlers (register/unregister/getVapidPublicKey/getPreferences/setPreferences)
  │
  ├─ push_subscriptions / push_preferences / push_user_default  (readstate DB)
  │
  └─ PushDispatcher (background loop, embed-sweeper pattern)
        ▲ poked by StreamManager.sendEvents on live createMessage
        │
     evaluatePush(event, spaceId, roomId):
        - resolve recipients: space members (edges label='member') + admins, read-access filtered, minus author
        - per recipient: lookup preference (per-space or default); skip Silent
        - Busy   → immediate push (coalesced per room)
        - Engaged→ mention? immediate : digest update + threshold check
        - Quiet  → mention? immediate : skip
        - update notification_state for digest; send via web-push to all the user's subscriptions

  Periodic sweep (every ~60s): Engaged digest rows whose 1h timer elapsed → fire once.
  updateSeen handler: reset notification_state for (user, room) — "until you open the room again".
```

The design deliberately mirrors two patterns already in the codebase:

- **The embed sweeper** (`src/embed/sweeper.ts`) — a single process-wide background loop
  that the `StreamManager` *pokes* but never drives directly. Push delivery is
  network-bound (calls to Mozilla/FCM/Apple push services) and must not block
  materialisation, so it gets the same treatment: a `PushDispatcher` background loop with
  a queue, poked by the `StreamManager`.
- **The readstate DB** (`data/roomy-readstate.sqlite`, attached as `readstate.*`) —
  appserver-owned state that survives materialisation DB wipes. All push state
  (subscriptions, preferences, digest state, participation) lives here for the same
  reason `read_positions` and `user_thread_activity` do: it cannot be reconstructed from
  the event log (the appserver now owns the event store, but readstate is still
  separate because it tracks user-scoped state that is not derivable from events).


## Web Push fundamentals

Web Push = VAPID + Push API + service worker + a push service per browser vendor.

- **VAPID keypair:** the appserver holds a private key (env: `VAPID_PRIVATE_KEY`,
  `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` e.g. `mailto:`). The public key is given to clients
  so they can create a `PushSubscription`.
- **Subscription:** the browser's `serviceWorkerRegistration.pushManager.subscribe({
  applicationServerKey })` returns a `PushSubscription` (`endpoint`, `keys.p256dh`,
  `keys.auth`, optional `expirationTime`). The client POSTs this to the appserver.
- **Delivery:** the appserver POSTs an RFC 8291 (`aes128g2`) encrypted payload to the
  subscription `endpoint`, with a VAPID-signed JWT in the `Authorization` header. The
  browser push service wakes the service worker, which calls
  `self.registration.showNotification()`.
- **Library:** use the `web-push` npm package in the appserver — it handles VAPID JWT
  signing + `aes128g2` encryption. (Bun runs it fine; it's pure JS.)

A VAPID keypair generator script lives in `packages/appserver/scripts/generate-vapid.ts`
(`noble`/`crypto` web-push keys), run once; keys stored in env / secrets.

## New XRPC lexicons

Add to `packages/sdk/src/schemas/lexicons/` and register in
`packages/sdk/src/schemas/{procedures,queries}/index.ts` (arktype schemas) so the
appserver router and the `app-lite` client both get typed bindings. Follow the exact
pattern of `joinSpace.json` / `updateSeen.json`.

| NSID | Type | Purpose |
|------|------|---------|
| `space.roomy.push.getVapidPublicKey` | query | Returns `{ publicKey: string }`. Public, no auth needed, but keep behind the same router for simplicity. |
| `space.roomy.push.registerSubscription` | procedure | Input: a `PushSubscription`-shaped object (`endpoint`, `keys.p256dh`, `keys.auth`, `expirationTime?`). Stores per `(userDid, endpoint)`. Idempotent on endpoint. |
| `space.roomy.push.unregisterSubscription` | procedure | Input: `{ endpoint }`. Removes the row. Called on unsubscribe / logout. |
| `space.roomy.push.getPreferences` | query | Returns `{ default: Level, perSpace: Array<{ spaceId, level }> }`. |
| `space.roomy.push.setPreferences` | procedure | Input: `{ default?: Level, spaceId?: string, level?: Level }`. If `spaceId` omitted → set default; else set/override per-space. `level` one of `silent|quiet|engaged|busy`. |

All procedures are authenticated via the existing PDS-proxy inter-service JWT path
(`parseUserDid(auth)`), identical to `updateSeen` / `joinSpace`. No new auth machinery.

Lexicon `Level` enum: `"silent" | "quiet" | "engaged" | "busy"`.

## Storage schema (readstate DB)

Bump `READSTATE_SCHEMA_VERSION` in `src/db/readStateDb.ts` and add a v3 migration
to the `MIGRATIONS` array in `src/db/worker.ts` (the worker owns readstate schema
lifecycle). Update `readStateSchema.sql` to reflect the final shape — the schema
file is applied via `db.exec()` on init (all `create table if not exists`), and the
migration ensures existing v2 DBs advance their version row to 3.

```sql
-- A device/browser subscription for a user. A user may have many (one per browser).
create table if not exists push_subscriptions (
  user_did        text not null,
  endpoint        text not null,          -- push service URL; unique per subscription
  p256dh          text not null,
  auth            text not null,
  expiration_time integer,                -- epoch ms, nullable
  created_at      integer not null default (unixepoch() * 1000),
  updated_at      integer not null default (unixepoch() * 1000),
  primary key (user_did, endpoint)
) strict;
create index if not exists idx_push_subs_user on push_subscriptions(user_did);

-- User-wide default notification level.
create table if not exists push_user_default (
  user_did text primary key,
  level    text not null check(level in ('silent','quiet','engaged','busy')) default 'engaged',
  updated_at integer not null default (unixepoch() * 1000)
) strict;

-- Per-space override. Absent row → fall back to push_user_default.
create table if not exists push_preferences (
  user_did  text not null,
  space_id  text not null,
  level     text not null check(level in ('silent','quiet','engaged','busy')),
  updated_at integer not null default (unixepoch() * 1000),
  primary key (user_did, space_id)
) strict;

-- Generalised "user sent a message / participated in this room" signal.
-- Used by the Engaged digest to restrict prompts to rooms you've spoken in.
-- (user_thread_activity is thread-only and owned by the sidebar; do not overload it.)
create table if not exists user_room_participation (
  user_did         text not null,
  room_id          text not null,
  last_message_at  integer not null,     -- epoch ms of the user's latest message in the room
  updated_at       integer not null default (unixepoch() * 1000),
  primary key (user_did, room_id)
) strict;
create index if not exists idx_user_room_participation_user
  on user_room_participation(user_did, last_message_at desc);

-- Per (user, room) digest state for the Engaged "occasional prompts".
-- One row = one pending/fulfilled batch of unseen messages since the user last
-- opened the room. Reset (deleted) by the updateSeen handler.
create table if not exists notification_state (
  user_did            text not null,
  room_id             text not null,
  first_unseen_at     integer,           -- epoch ms of the first unseen message in this batch
  first_unseen_msg_id text,              -- anchor message ULID
  unseen_count        integer not null default 0,
  notified            integer not null default 0 check(notified in (0,1)),
  pushed_at           integer,
  updated_at          integer not null default (unixepoch() * 1000),
  primary key (user_did, room_id)
) strict;
-- Sweep index: find due digests (notified=0, first_unseen_at + 1h <= now).
create index if not exists idx_notification_state_due
  on notification_state(notified, first_unseen_at);
```

Rationale for `notification_state` being separate from `read_positions`:
- `read_positions.unread_count` is incremented for *all* users with an existing row on
  every live `createMessage` (`applyBundle.ts`), but that row is created **lazily** on
  first query — so a user who has never opened a room has no row and no counter. Push
  cannot depend on that.
- The digest needs its own batch boundary (`first_unseen_at`, `notified`) and its own
  reset semantics ("until you open the room again"), which are distinct from the read
  watermark. Keeping it separate avoids overloading `read_positions` and survives
  materialisation DB resets (it's in readstate).

## Preference model & routing

`resolveLevel(userDid, spaceId)`:
1. `push_preferences` row for `(userDid, spaceId)` → if present, use it.
2. else `push_user_default` row → if present, use it.
3. else default **`engaged`** (matches the copy's highlighted ✅ option).

Default on first `joinSpace`: the join flow sends the chosen `level` via
`setPreferences` immediately after `joinSpace` returns. The appserver's `joinSpace`
handler is *not* modified to accept a level — preferences stay a separate concern on a
separate endpoint, keeping join atomic. (If we later want server-side atomicity we can
add an optional `notificationLevel` to the `joinSpace` input; not needed for MVP.)

On `leaveSpace`: per-space preference rows can remain (they're harmless and let
rejoining keep your setting); subscriptions are user-scoped, not space-scoped, so they
stay. We only need to stop pushing — which happens naturally because the leaver is no
longer a member (no `edges ... label='member'` row) so they drop out of the recipient
set.

## Push evaluation pipeline

### Hook point

`StreamManager.sendEvents()` writes events to the appserver-owned events DB,
materialises them inline via `applyBatch`, emits invalidation signals, pokes the
embed sweeper, and notifies stream listeners. A parallel poke to the
`PushDispatcher` is added in step 6b of `sendEvents()` (alongside
`pokeEmbedSweeper()`), for live `createMessage` events only. The poke builds
`PushJob[]` from the `AppliedEvent[]` already computed for invalidation,
reusing `toAppliedEvent`'s `authorDid` (which handles the `authorOverride`
extension for bridged messages).

This keeps push out of the hot materialisation path: `sendEvents` only enqueues
a small job; all DB lookups + network delivery happen in the background loop.

### `PushDispatcher` (new: `src/push/dispatcher.ts`)

Single process-wide background loop, modelled on `embed/sweeper.ts`:

- `poke(jobs: PushJob[])` — enqueue live createMessage jobs; wake an idle loop.
- Drain loop: for each job, `evaluatePush(job)` then send.
- Bounded concurrency for outbound push-service calls (push services can be slow; never
  flood). Sequential or small-concurrency, with per-call timeout.
- Idle poll every ~60s that also runs the **digest sweep** (see below) so due Engaged
  digests fire even with no new pokes.
- Self-healing backoff on push-service errors (429/5xx), and **prune** subscriptions
  that return 404/410 (the browser unsubscribed / expired) — delete the
  `push_subscriptions` row.

### `evaluatePush(job)` (new: `src/push/evaluate.ts`)

For a live `createMessage` in `roomId` (space `streamDid`), author `authorDid`:

1. **Resolve message facts:** `roomId`, `spaceId` (= `streamDid`), author DID (use
   override-author if the `authorOverride` extension is present — same logic as the
   materializer), message timestamp (`decodeTime(messageId)`), and a plain-text preview
   for the notification body (decoded from `comp_content`; see §Payload).
2. **Enumerate recipients:** `select * from edges where head = spaceId and label = 'member'`
   (reuse the same membership query `getMembers` uses) ∪ admin edges. Filter to users
   with `roomAccess(db, roomId, userDid).canRead` (reuse `auth/access.ts`). Exclude the
   author.
3. **For each recipient** (batch via one SQL join against
   `push_preferences`/`push_user_default` + `push_subscriptions` to avoid N queries):
   - `level = resolveLevel(userDid, spaceId)`. Skip `silent`.
   - `busy` → enqueue an **immediate** push for this message (subject to burst
     coalescing, below).
   - `quiet` → if mentioned(userDid) → immediate push; else skip.
   - `engaged` → if mentioned(userDid) → immediate push; else **digest path** (below).
   - Only enqueue if the user has ≥1 `push_subscriptions` row.
4. **Send:** for each enqueued push, call `web-push` to every subscription endpoint for
   that user. On 404/410, delete the subscription.

### Busy burst-coalescing

"Busy" can fire a push per message in an active room, spamming the push service and the
user. Coalesce: maintain a short in-memory + readstate `notification_state`-style
window per `(user, room)` — collapse messages within e.g. 30s into a single
notification ("5 new messages in #room"). Reuse the `notification_state` table with a
`busy_window_until` column (or a separate small table) so coalescing survives the
60s sweep. This keeps Busy tractable; the exact window is a tunable.

### Engaged digest path (the primary deliverable)

For an Engaged recipient who was **not** mentioned, on a live `createMessage` in
`roomId`:

1. **Participation gate:** only proceed if a `user_room_participation` row exists for
   `(userDid, roomId)`. (Set when the user sends a message in the room — see below.)
   Rooms you've never spoken in never get a digest prompt.
2. **Upsert `notification_state`:**
   - If no row: insert with `first_unseen_at = msgTimestamp`, `first_unseen_msg_id =
     messageId`, `unseen_count = 1`, `notified = 0`.
   - If row exists and `notified = 0`: `unseen_count += 1` (leave `first_unseen_at` as
     the earliest).
   - If row exists and `notified = 1`: do nothing — a push already went out for this
     batch; stay quiet until the user reopens the room (which resets the row).
3. **Threshold check (immediate, on-event):** if `notified = 0` and `unseen_count >= 5`
   → fire the digest push, set `notified = 1`, `pushed_at = now`.
4. **Time threshold (periodic sweep):** every ~60s, select `notification_state` rows
   where `notified = 0` and `first_unseen_at is not null` and
   `first_unseen_at + 3600_000 <= now`; for each, fire the digest push, set `notified =
   1`, `pushed_at = now`.

"Fire the digest push" = one notification to all the user's subscriptions: *"New
activity in <room> — N messages since you were last here"* (or similar copy), with a
click-through URL to the room. **One push per room per batch** is enforced by the
`notified` flag.

### Reset on room open ("until you open the room again")

Hook into the existing `space.roomy.room.updateSeen` handler
(`src/handlers/space.roomy.room.updateSeen.ts`): after a successful `updateSeen` for
`(userDid, roomId)`, **delete the `notification_state` row** for that pair. This
cancels any pending digest and re-arms the batch for the next burst. `app-lite` already
calls `updateSeen` when the active room receives a `#messageDiff`
(`src/lib/sync.svelte.ts` → `onMessageDiff` → `updateSeen`), so "opening the room" is
already wired. (Nuance, acceptable for MVP: `updateSeen` is also called with a
watermark while scrolling; we reset on any `updateSeen` for the room, which is correct
enough — while the room is open, unseen stays ~0 and no digest fires anyway.)

### Participation tracking

`applyBundle.ts` already upserts `user_thread_activity` for thread authors. Add, in the
same live-`createMessage` branch, an upsert into the new `user_room_participation` for
**every** room type (channels included), keyed by `(author, roomId)` with
`last_message_at = decodeTime(event.id)`. This is the "rooms you have sent a message in"
signal the Engaged gate needs. (For bridged messages, use the override author, matching
the `author` edge logic.) A lazy backfill helper — analogous to
`backfillUserThreadActivity` — seeds participation from historical authored messages so
existing users get digests without sending a new message first.

## Mention detection

There is **no mention representation in the event schema today** (`createMessage` carries
only `body: Content` + attachments/extensions; no `mentions` field, and a grep for
"mention" across `packages/sdk` finds nothing). Two options:

1. **Recommended — add an extension:** `space.roomy.extension.mentions.v0` on
   `createMessage`, carrying `mentions: string[]` (DIDs). The TipTap editor in `app-lite`
   already knows which DIDs a mention node resolves to; populate the extension on send.
   Server-side mention detection becomes a trivial set membership check. This is
   ATProto-native and reliable.
2. Parse mentions out of the rich-text `Content` blob at evaluation time. Fragile (must
   decode CBOR + walk TipTap JSON + resolve handles→DIDs) and lossy for bridged content.

**MVP decision:** ship the plumbing and preference routing now, with mentions routed
through option 1 the moment the extension exists. Until then, `quiet` == `silent` and
`engaged` runs **digest-only** (which is exactly the detailed behaviour the user
specified first). This lets us deliver the Engaged digest without blocking on the
mention extension, and Quiet becomes meaningful as soon as mentions land.

## Notification payload & click-through

- Payload (JSON, encrypted by `web-push`): `{ type, spaceId, roomId, messageId?, count?,
  body }` where `type ∈ {'message','digest'}`. Keep it small (push service size limits).
- Service worker (`app-lite`): on `push`, decode payload, `showNotification(title, {
  body, data: { spaceId, roomId }, tag })`. `tag` = `room:<id>` so a room's notifications
  replace each other (coalescing for Busy/digest). On `notificationclick`, focus an
  existing tab and `goto('/${spaceId}/${roomId}')`, else open one.
- Plain-text preview for the body: decode `comp_content.data` for the message's
  `mimeType`. For `text/markdown`/`text/plain` it's the raw text (truncated). For the
  TipTap JSON mime, walk the doc for text nodes (a small extractor in
  `src/push/preview.ts`). Avoid leaking content from rooms the recipient can't read —
  but recipients are already read-access-filtered, so this is safe.

## Frontend (`app-lite`) changes

- **Service worker:** `src/service-worker.ts` (SvelteKit service-worker route) handling
  `push` + `notificationclick`. Registered on login.
- **Push subscription hook** (`src/lib/push.svelte.ts`): on login, ensure SW registered,
  fetch `push.getVapidPublicKey`, `pushManager.subscribe`, call
  `push.registerSubscription`. On logout/permission revocation, `unregisterSubscription`.
- **Queries/mutations** under `src/lib/{queries,mutations}/`: `push.ts` wrappers for the
  five new XRPC methods.
- **Shared UI component** in `@roomy/design`: `UpdateRhythmChooser.svelte` — the four
  options with the ❌🍃💌👀 copy. Used by:
  - `/join` flow (`src/routes/join/+page.svelte` / `JoinDialog.svelte`) — choose a
    per-space level, then `setPreferences({ spaceId, level })` after `joinSpace`.
  - Per-space settings (`src/routes/[space]/settings/`) — a new "Notifications" section.
  - `/user/settings/notifications` — currently a greyed-out placeholder in the sidebar
    (`src/routes/user/settings/+page.svelte`); make it live: default-level chooser +
    subscription/device list + browser-permission prompt + enable/disable.
- **Notification badge/unread** is already server-driven via `getMetadata.unreadCount`;
  no change needed there.

## Membership / read-position prerequisites

The push evaluator does **not** depend on `read_positions` rows existing (it enumerates
recipients from `edges ... label='member'` directly), which sidesteps the lazy-row gap
in `applyBundle`'s `unread_count` increment. The only place read positions matter for
push is the `updateSeen` reset hook, and that only *deletes* a `notification_state` row —
safe whether or not a `read_positions` row exists.

No change to the lazy `ensureReadPositions` strategy is required for push.

## Phasing / implementation plan

**Phase 1 — Plumbing (no user-facing push yet)**
- VAPID keypair script + env; `web-push` dependency in `packages/appserver`.
- readstate schema v3: `push_subscriptions`, `push_user_default`, `push_preferences`,
  `user_room_participation`, `notification_state` (+ migration).
- Five push lexicons + arktype schemas; handlers
  `src/handlers/space.roomy.push.*.ts`; register in `src/index.ts`.
- `app-lite` service worker + `push.svelte.ts` subscribe-on-login + `push.ts`
  query/mutation wrappers.
- End-to-end: a manual `setPreferences` + a test message produces a real browser
  notification (Busy level, no digest yet).

> **Phase 1 implementation status (2026-06-24).** All plumbing above is landed.
> The minimal Busy immediate-push slice the Phase 1 E2E test needs is included
> even though the full dispatcher/digest loop is nominally Phase 2:
> `src/push/{types,level,webpush,evaluate,dispatcher}.ts` +
> `src/queries/{pushPreferences,pushSubscriptions}.ts`, the `StreamManager`
> live-createMessage poke, and the 5 handlers + `appserver.ts` route registration
> + `/health/push`. `evaluate` is Busy-only (digest/participation/mentions
> deferred). Covered by `src/push/evaluate.test.ts` (Busy delivery, author
> exclusion, engaged-no-immediate, banned-access filter, no-subscription
> skip, per-space silent override) — run with `bun test src/push/evaluate.test.ts`.
>
> **Manual E2E (Busy notification) — requires a browser + push service:**
> 1. Generate a VAPID keypair: `bun run packages/appserver/scripts/generate-vapid.ts`.
> 2. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in the
>    appserver env (see `.env.example`).
> 3. Start the appserver (`pnpm dev` / `bun run packages/appserver/src/index.ts`)
>    and `pnpm dev:lite`.
> 4. In a browser, log in to app-lite and open **Settings → Notifications**
>    (`/user/settings/notifications`). Click **Enable notifications** — this
>    requests permission from a user gesture (Safari requires this) and
>    registers the subscription. Verify `GET /xrpc/space.roomy.push.getVapidPublicKey`
>    returns the key and a `push_subscriptions` row exists.
> 5. On the same page, set the **Default level** to **Busy** (or set a
>    per-space override).
> 6. From a second account in the same space, post a message in a room the
>    busy user is a member of. A real notification appears (title
>    "<author> in <room>", no body content). `GET /health/push` shows
>    `deliveredOk` increment.
> 7. Click **Disable on this device** (or sign out) — `clearPushSubscription()`
>    unregisters the endpoint; no further pushes arrive on that device.
>
> **Verified browsers:** Firefox / Firefox forks (Zen) work end-to-end
> (Mozilla push service, pure HTTPS). Google Chrome / Edge / Brave / Vivaldi
> work (FCM with bundled Google API keys). Safari 16.1+ works once the user
> clicks Enable (the permission prompt requires a user gesture). Vanilla
> `chromium` / ungoogled-Chromium forks without Google FCM keys cannot do web
> push — `pushManager.subscribe()` times out; this is a browser limitation, not
> fixable in app code. A 20s timeout on `subscribe()` fails gracefully with a
> clear console message instead of hanging forever.
>
> **Bugs found and fixed during E2E testing:**
> - `registerSubscription` rejected Firefox's `expirationTime: null`
>   (arktype `expirationTime?: number` didn't accept null) → schema now
>   `number | null`; the handler/DB already handled null.
> - web-push `topic: \`room:<roomId>\`` failed validation ("Unsupported
>   characters set") because the Web Push `Topic` header must be ≤32 base64url
>   chars and `room:` contains `:` → now a sha256→base64url→slice(32) of the
>   roomId, preserving per-room coalescing.
> - `Notification.requestPermission()` at login is blocked on Safari (no user
>   gesture) → login now only re-subscribes if permission is already granted
>   (`subscribeIfAlreadyPermitted`); the settings page's Enable button is the
>   one prompt trigger.

**Phase 2 — Engaged digest (the primary deliverable)**
- `PushDispatcher` + `evaluate.ts` background loop; materializer poke on live
  `createMessage`.
- `user_room_participation` upsert in `applyBundle` + lazy backfill.
- `notification_state` upsert + 5-message threshold (on-event) + 1h sweep.
- `updateSeen` reset hook.
- `app-lite` `UpdateRhythmChooser` in join flow; ~~`/user/settings/notifications`
  page live~~ (DONE in Phase 1 — status + Enable button (Safari-gesture-safe),
  default level selector, per-space overrides).

> **Phase 2 implementation status (2026-06-29).** Landed:
> - `src/queries/userRoomParticipation.ts` — `upsertUserRoomParticipation`
>   (all room types, override-author aware), `hasUserParticipatedInSpace`
>   (lazy backfill once per user+space via a process-lifetime cache), +
>   `_resetParticipationBackfillCache` for tests.
> - `src/materialization/applyBundle.ts` — upserts the effective author's
>   participation on every live `createMessage` (override-author if the
>   `authorOverride.v0` extension is present, else the stream user).
> - `src/queries/notificationState.ts` — `upsertNotificationState` (atomic
>   increment + on-event 5-message threshold that marks `notified` inline),
>   `selectDueDigests` (1h sweep query), `markNotified`, `resetNotificationState`.
> - `src/push/evaluate.ts` — extended with the Engaged digest path:
>   read-access + subscription checks are now shared across `busy`/`engaged`;
>   `engaged` gates on participation, upserts digest state, and emits an
>   on-event `digest` delivery when the threshold is reached. `quiet` is
>   skipped (no mentions until Phase 3). `silent` skipped.
> - `src/push/dispatcher.ts` — refactored delivery into a shared
>   `deliverPayload`; added `runDigestSweep` on every idle wake (resolves
>   roomName + spaceId from the room entity, fires time-based digests, marks
>   notified); added `digestsFired` to `/health/push`.
> - `src/handlers/space.roomy.room.updateSeen.ts` — deletes the
>   `notification_state` row on read ("until you open the room again").
> - `@roomy/design` `components/user/UpdateRhythmChooser.svelte` — the shared
>   ❌🍃💌👀 chooser (exports `RHYTHM_OPTIONS`, `RhythmLevel`, `DEFAULT_RHYTHM`).
> - `JoinDialog.svelte` renders the chooser in the join flow and passes the
>   chosen level out via `onJoin(level)`; both app-lite callers
>   (`routes/join/+page.svelte`, `JoinSpaceModal.svelte`) persist it via
>   `setSpacePushLevel` after `joinSpace` (best-effort, never blocks join).
> - Service worker already handled the `digest` payload type from Phase 1.
> - Tests: `src/push/evaluate.test.ts` (6 Busy + 6 Engaged digest + 3
>   notificationState upsert = 15) and `applyBatch.test.ts` (2 participation).
>   Full appserver suite: 257 pass, 1 skip, 0 fail.
>
> **Manual E2E (Engaged digest) — requires a browser + push service:**
> 1. Appserver running with VAPID keys; `pnpm dev:lite`.
> 2. User A: enable notifications (Settings → Notifications → Enable), keep
>    default level **Engaged**, and **send a message in a room** (so they have a
>    `user_room_participation` row — the digest gate requires participation).
> 3. User A closes/leaves the room (so new messages become unseen).
> 4. User B posts 5 messages in that room. On the 5th, the appserver fires an
>    on-event digest: User A gets one notification "5 new messages in <room>",
>    and `GET /health/push` shows `digestsFired` increment. `notification_state`
>    for (A, room) is now `notified=1`; a 6th message does NOT re-fire.
> 5. **Time threshold:** with a fresh batch (User A reopens the room to reset,
>    then leaves), User B posts 1–4 messages (below threshold). Wait 1 hour
>    (or temporarily lower `DIGEST_WINDOW_MS` for testing). The dispatcher's
>    idle sweep fires one digest; `digestsFired` increments.
> 6. User A reopens the room → `updateSeen` deletes the `notification_state`
>    row → a new burst can fire another digest.
>
> **Note on the digest gate:** only rooms the recipient has **sent a message
> in** get digests (the participation gate). A room the recipient merely
> joined/read but never spoke in never prompts. Existing users get backfilled
> lazily (once per user+space) so they don't have to send a new message first.
>
> **Notification icons (avatars).** Payloads carry an `icon` — a
> browser-fetchable avatar URL the OS shows on the notification. The appserver
> resolves it from `comp_info.avatar` (`src/push/avatars.ts`), mirroring
> `app-lite`'s `resolveBlobUrl` exactly (`atblob://<did>/<cid>` →
> `https://cdn.bsky.app/img/feed_fullsize/plain/<did>/<cid>`; plain URLs pass
> through). **Both message and digest pushes use the same rule: sender avatar →
> space avatar** ("user avatars, or failing that, space avatars"). For the
> on-event digest the sender is the triggering author; for the time-based
> sweep it's the room's most-recent author (`resolveLatestRoomAuthor`).
>
> *Why sender-first, not room/space-first:* empirically (inspected the live
> `data/roomy.sqlite`) rooms have **0** avatars and only 11/38 spaces have one —
> and those space avatars are `atblob://` refs whose blobs **404 on
> `cdn.bsky.app`** (not on Bluesky's CDN), so they never render. User avatars,
> by contrast, are materialised as pre-resolved plain `https://` URLs that load
> (HTTP 200). Putting the sender avatar first surfaces a usable icon for the
> vast majority of notifications. If neither resolves the `icon` field is
> omitted and the notification shows with no icon. The service worker passes
> `payload.icon` straight to `showNotification({ icon })`; the OS fetches the
> image itself (it is not part of the encrypted payload bytes). Tested in
> `avatars.test.ts` (resolver + `resolveLatestRoomAuthor`) and `evaluate.test.ts`
> (message + digest icon cases).

**Phase 3 — Mentions (unblocks Quiet + Engaged immediate)**
- `space.roomy.extension.mentions.v0` in SDK; `app-lite` editor populates it.
- `mentioned(userDid)` check in `evaluatePush`; route Quiet/Engaged immediate pushes.

**Phase 4 — Polish**
- Busy burst-coalescing window; subscription pruning on 404/410; delivery retry/backoff;
- quiet "nudge" (separate design); per-room overrides / DND schedules (future).

## Open questions / decision points

1. **"Rooms you have sent a message in" — threads only, or all rooms?** The user said
   "rooms"; messages can live in channels too. Plan proposes a general
   `user_room_participation` (all room types). If we decide digests are threads-only,
   reuse `user_thread_activity` and drop the new table. → **Recommend general.**
2. **Busy coalescing window length** (30s proposed) and digest copy wording — UX, decide
   in review.
3. **Notification permission prompt timing** — prompt on first login (aggressive) vs. on
   first explicit "enable" in settings (polite). → **Recommend polite** (settings +
   join flow both act as explicit consent surfaces).
4. **Push payload content preview** — include sender name + truncated text, or just
   "N new messages in #room"? Preview is friendlier but sends content through the push
   service (third party). → **Recommend counts + room/sender names only** for the
   initial release; no message body in the push payload.
5. **Multi-node appserver** — the `PushDispatcher` + sweep are per-process. Fine for the
   current single-node Bun deployment; when we horizontalise (or move to Rust) the
   sweep needs to be leader-elected or partitioned. Note, don't solve now.
6. **VAPID subject / appserver DID** — VAPID uses a `mailto:` or URL subject, separate
   from the appserver DID. Decide and document in `.env.example`.

## Files to add / modify

**appserver**
- `scripts/generate-vapid.ts` (new)
- `package.json` — add `web-push` dep
- `src/db/readStateSchema.sql`, `src/db/readStateDb.ts` (schema v3)
- `src/db/worker.ts` — v3 migration in `MIGRATIONS` array (push tables)
- `src/push/dispatcher.ts`, `src/push/evaluate.ts`, `src/push/avatars.ts`,
  `src/push/webpush.ts`, `src/push/types.ts`, `src/push/level.ts` (new)
- `src/handlers/space.roomy.push.{getVapidPublicKey,registerSubscription,unregisterSubscription,getPreferences,setPreferences}.ts` (new)
- `src/streams/StreamManager.ts` — poke dispatcher on live createMessage (step 6b)
- `src/materialization/applyBundle.ts` — upsert `user_room_participation` (async)
- `src/queries/userRoomParticipation.ts` (new, + lazy backfill)
- `src/queries/pushPreferences.ts` (new — `resolveLevel`, get/set)
- `src/queries/pushSubscriptions.ts` (new)
- `src/queries/notificationState.ts` (new)
- `src/handlers/space.roomy.room.updateSeen.ts` — delete `notification_state` row
- `src/appserver.ts` — register push routes in `buildRouter()`, start dispatcher,
  `/health/push` endpoint, `_resetPushDispatcher()` in close()
- `.env.example` — `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`

All query helpers and the push pipeline (`evaluate.ts`, `dispatcher.ts`, `avatars.ts`,
handlers) use the async `DbLike` interface (worker-backed), not sync `Database`.

**sdk**
- `src/schemas/lexicons/space.roomy.push.*.json` (new, 5 files)
- `src/schemas/queries/index.ts`, `src/schemas/procedures/index.ts` — register schemas
- `src/transport/registry.ts` — register in `QUERY_SCHEMAS` / `PROCEDURE_SCHEMAS`
- (Phase 3) `src/schema/events/extensions/message.ts` — `mentions.v0` extension

**app-lite**
- `src/service-worker.ts` (new)
- `src/lib/push.svelte.ts` (new), `src/lib/queries/push-preferences.ts`,
  `src/lib/queries/vapid-public-key.ts`, `src/lib/mutations/push-preferences.ts`,
  `src/lib/mutations/push-subscription.ts`, `src/lib/push-debug.ts` (new)
- `src/routes/user/settings/notifications/+page.svelte` (new; un-grey the sidebar link)
- `src/routes/user/settings/+page.svelte` — add Notifications link
- `src/routes/join/+page.svelte` / `JoinSpaceModal.svelte` — add `UpdateRhythmChooser`
- `src/routes/+layout.svelte` — register service worker
- `src/lib/auth.svelte.ts` — subscribe on login if permission already granted
- `src/lib/config.ts` — add push XRPC scope

**design (`@roomy/design`)**
- `components/user/UpdateRhythmChooser.svelte` (new) — the ❌🍃💌👀 chooser, shared
- `components/modals/JoinDialog.svelte` — render chooser in join flow