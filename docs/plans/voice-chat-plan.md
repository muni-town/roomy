# Voice Chat in Roomy — Implementation Plan

**Date:** 2026-08-28
**Status:** Draft for review
**Author:** Chanterelle
**References researched:** `chattocorp/chatto` (main, 2026-08-28) and `colibri-social/colibri.social` + `colibri-social/appview` (main, 2026-08-25).

## 1. Summary

Roomy should implement voice chat with **LiveKit as an external WebRTC SFU**, following Chatto's architecture (durable room-scoped call facts + webhook-driven participant state + reconciliation), and adopting Chatto's testing discipline (build-tag-gated test webhook endpoints, real-binary E2E, mocked-media unit tests). Colibri's embedded-mediasoup approach is instructive for signaling/presence design but is the wrong fit for Roomy's transitional Bun/TS appserver.

Recommended scope for v1: **voice-only rooms** (mic + listen), persistent "who's in the call" presence over the existing sync WebSocket, call join/leave + participant lists, per-call E2EE, graceful degradation when LiveKit is unconfigured. Video and screen share follow in later phases.

## 2. Reference Project 1: Chatto (chattocorp/chatto)

Go event-sourced backend (embedded NATS JetStream) + Svelte 5 frontend. Voice/video calls are first-class, LiveKit-based.

### 2.1 How Chatto uses LiveKit

- **LiveKit is an external service.** Chatto's backend never touches media; it mints LiveKit JWTs and consumes LiveKit webhooks. Config: `[livekit] enabled / url / api_key / api_secret / webhook_url / server_id` (`cli/internal/config/integrations.go`).
- **Token issuance** (`cli/internal/core/voice.go`): `GenerateVoiceCallToken` embeds user identity (login, avatar URL, bot flag) as JSON in the token's `metadata` field so the frontend renders participant cards without extra queries. `VoiceCallTokenTTL = 5 min`; a separate short-lived `CreateCallMediaPublisherToken` covers native companion publishers (desktop game capture).
- **Deterministic room naming**: `{serverID}.{legacySpaceID}.{roomID}@{callID}`. The `@{callID}` suffix lets webhooks and reconciliation attribute events to one specific call generation, so stale events from a previous call are ignored.
- **Webhook-driven state** (`cli/internal/http_server/webhooks.go`): `POST /webhooks/livekit` HMAC-validates LiveKit events (`participant_joined`, `participant_left`, `room_finished`) and appends durable call facts. Webhook key pair can differ from the per-server API key (shared LiveKit clusters).
- **Durable call facts** (ADR-009, FDR-016): `CallStartedEvent`, `CallParticipantJoinedEvent`, `CallParticipantLeftEvent`, `CallEndedEvent` live on the **room aggregate**, with internal source enum `USER` (explicit client intent) / `LIVEKIT` (webhook) / `RECONCILIATION` (reconciler). Duplicate transitions (same participant, same state) are collapsed idempotently; a real join/leave/rejoin still records each change.
- **One active call per room.** Rooms are the call primitive: "future private, temporary, or otherwise non-public calls should be modeled as rooms" — inheriting membership, authorization, visibility, and delivery.
- **Projection-backed reads**: a call-state projection over durable facts serves `activeCallRoomIds` / `callParticipants`; the UI may show optimistic USER state briefly, corrected by webhooks or reconciliation.
- **Reconciliation** (`cli/internal/core/call_model.go`): single-leader (lease `livekit_reconciler`) periodic loop (30 s ticker) lists LiveKit rooms/participants and appends correction facts for mismatches. Missing/empty LiveKit rooms end the call immediately after a successful listing. **Three consecutive list failures** end all projected active calls (recovery over false liveness); failures are counted in shared KV and reset by any successful pass.
- **E2EE per call** (ADR-007-style crypto-shredding): first join creates a call ID + per-call key through the KMS boundary, stored raw in `ENCRYPTION_KEYS`, only a key ref in EVT; `CallEndedEvent` shreds the key (idempotent, retried by a durable consumer). Frontend uses `ExternalE2EEKeyProvider` + LiveKit E2EE worker, sets key, enables E2EE, then connects.
- **Graceful degradation**: when LiveKit is not configured, all voice APIs return null/empty and the frontend hides all call UI.
- **Frontend** (`apps/frontend/src/lib/state/server/voiceCall.svelte.ts`, ~1500 lines): a `VoiceCallState` class owns the LiveKit `Room` lifecycle; `livekit-client` is **dynamically imported** (code-split, keeps initial bundle small); audio published mono with `AudioPresets.speech`, DTX, RED, simulcast, dynacast, adaptive stream; media-device failures are classified (`permission-denied | not-found | in-use | constraint | aborted | unknown`) and mapped to actionable messages; join/leave are coalesced while in flight; a compensating leave is recorded if LiveKit connect fails after join intent; call sound cues are driven by durable join/leave events (including your own, deferred until connection).
- **Screen share / video**: camera + screen share are LiveKit track state on joined clients only; observers never see share state. Desktop adds a native macOS companion publisher (own opaque LiveKit identity, E2EE key shared) with multi-layer simulcast. Not needed for v1.
- **Room lifecycle integration**: leaving the room / being removed / banned / account deletion removes the user from the active call, disconnects local media, and best-effort asks LiveKit to remove the participant (reconciliation catches failures).

### 2.2 Chatto's testing & verification (Meri's focus)

Chatto has a three-tier, defense-in-depth verification culture:

1. **Go unit tests against real infrastructure.** `cli/internal/core/voice_test.go` (~2300 lines, ~55 tests) covers token generation, room-name parsing, E2EE key lifecycle, and the call-state projection using **embedded NATS JetStream** (real streams, KV, ordering). LiveKit itself is faked via small interfaces (`liveKitParticipantLister`, `recordingLiveKitParticipantClient`); failure injection (list errors, shred errors, timeouts) is systematic: reconciliation thresholds, stale-event guards, conflict rechecks, key-shred retry across replicas all have dedicated tests.
2. **Frontend Vitest with full LiveKit mocking.** 321 `.spec.ts` files. `voiceCall.svelte.spec.ts` (1228 lines, **42 tests**) mocks the entire `livekit-client` module (Room, ExternalE2EEKeyProvider, device enumeration) with controllable gates for connect/mic/camera/screen-share failures, and asserts behavior: E2EE setup before connect, mono capture config, deferred join sounds, join-intent compensation, coalescing, native share lifecycle. Vitest runs three projects: `server` (node), `client` (chromium via `@vitest/browser-playwright` for `.svelte` component tests), and `storybook` (Storybook + `@storybook/addon-vitest` browser tests; 71 stories including 4 voice components). `expect.requireAssertions: true` — no assertion-less tests.
3. **Playwright E2E against a real compiled binary** (ADR-020). `mise build-e2e-server` compiles the Go server with build tags `bootstrap nomsgpack test_endpoints`. The `test_endpoints` tag compiles test-only HTTP routes **into the binary** (`/auth/test/*`, `/webhooks/test/call-join`, `/webhooks/test/call-leave`, `/webhooks/test/call-room-finished`) that bypass LiveKit HMAC and call the core handlers directly — a production build literally lacks this code (stronger than a config flag). Each test spawns its own Chatto process with an ephemeral data directory and random ports (full isolation, fully parallel). `voice-call.spec.ts` (~650 lines, 14 tests) exercises the whole chain with **no real LiveKit in CI**: `test.use({ serverOptions: { env: { CHATTO_LIVEKIT_ENABLED: 'true', ... } } })` scopes env to the spawned server; token RPCs assert valid 3-part JWTs + e2eeKey + callId; join/leave/participant flows drive the UI via the test webhook endpoints and assert real-time icon/panel/timeline updates across two browser contexts; one test verifies `livekitUrl` surfaces in runtime config. Camera/video (real WebRTC) is explicitly documented as manual-only (`mise dev`).
4. **CI** (`.github/workflows/ci.yml`): workspace typecheck + lint + unit tests + Storybook build; Go test suites (authling, appconfig, datacrypto, events, natsruntime, cli); E2E in a **4-shard Playwright matrix**; a separate `@ffmpeg` media E2E job; a **performance regression job** that runs a large synthetic-server benchmark on base SHA vs PR SHA (`e2e-performance/large-server.performance.test.ts`) and fails on regression.
5. **Documentation discipline**: every decision is an ADR (ADR-009 webhook-driven call state, ADR-020 build-tag test endpoints, ADR-007 crypto-shredding); every feature behavior is an FDR (FDR-016 Voice Calls is the canonical spec — permissions, edge cases, design tradeoffs); agents get repo skills (`.agents/skills/`) that encode invariants (e.g. the "audio must be explicitly `track.attach()`ed" gotcha).

## 3. Reference Project 2: Colibri (colibri-social/colibri.social)

AT Protocol chat: SolidJS client (`packages/client`) + Rust AppView (`colibri-social/appview`). **Does not use LiveKit** — it embeds a **mediasoup** SFU in the Rust AppView.

### 3.1 How Colibri does voice

- **Embedded SFU** (`appview/src/sfu.rs`): mediasoup Router per voice channel, Opus audio + VP9 video codecs, `SFU_WORKER_COUNT` workers, UDP+TCP ICE with announced IP (`SFU_ANNOUNCED_IP`), RTC port range 40000–40100, optional TURN via `SFU_ICE_SERVERS`. Linux-only ("mediasoup does not build on Windows"); the `sfu.rs` module has a `#[cfg(windows)]` stub that reports `status() = disabled`.
- **Custom signaling**: `social.colibri.voice.signal` is a WebSocket XRPC endpoint (`signal_handler.rs`) using the mediasoup-client protocol: `init` (router RTP capabilities, transport options, ICE servers) → `connectProducerTransport`/`connectConsumerTransport` (DTLS) → `produce`/`consume` → `producerAdded`/`producerRemoved`/`activeSpeakers` server pushes. Auth via WebSocket subprotocol (same `colibri.auth.bearer` + service-auth JWT pattern as their sync socket). Per-connection per-channel transports; one SFU per channel, access authorized per channel URI + membership.
- **Voice channels are a channel type**: `social.colibri.channel.voice` in the channel record lexicon, alongside `.text`, `.forum`, `.link`.
- **Presence is off-protocol, over the sync socket**: clients send `voice_join` / `voice_leave` / `voice_state` (muted/deafened) messages on the ordinary `subscribeEvents` socket; the AppView broadcasts `voice_presence_event` / `voice_state_event` to the community scope. **Humming** relays these ephemeral signals across AppView instances (hub/leaf star, inter-service JWT, `presenceService` opt-in, closed union of `userEvent|typingEvent|voicePresenceEvent`) so presence works when members are spread across self-hosted instances. Voice state is ephemeral — never a repo record, never retained.
- **Moderation**: `social.colibri.voice.moderate` XRPC (mute / unmute / deafen / undeafen / disconnect) with role-based authz (`Permission::VoiceModerate`, outranks check); applies via a `VoiceControlCommand` channel to the SFU, plus persisted server-mute/deafen state per member surfaced in presence.
- **Client audio pipeline** (`contexts/VoiceChat.tsx`, 1650 lines): `mediasoup-client` `Device`; mic → **RNNoise suppression in a Colibri-owned AudioWorklet** (speech probability drives the speaking indicator), voice gate, input gain; per-participant volume overrides + output device via `setSinkId`; RTT-based connection-quality polling (3 s, 400 ms fast path); teardown avoids `producer.close()` renegotiation races by stopping tracks then closing transports; single-user voice exclusivity ("superseded") and server mute/deafen enforced both in SFU and UI.
- **Privacy posture** (docs/privacy): media is DTLS-SRTP encrypted in transit, **not E2EE**, not recorded, discarded on disconnect; IPs visible to SFU and (depending on network) other participants.

### 3.2 Colibri's testing

- Client: 90 Vitest test files (happy-dom, no browser E2E in the repo). Voice tests are **pure-function unit tests**: `voice-presence.test.ts` (presence diff/merge logic) and `voice-device.test.ts` (handler selection across Tauri/Safari/iOS/Chrome/Firefox user agents). The 1650-line `VoiceChat.tsx` has no direct test — media code is untested at unit level.
- AppView: 120 Rust modules with `#[cfg(test)]` unit tests (e.g. `voice_moderation.rs` tests the lookup abstraction), but **no tests for the SFU itself** (mediasoup integration untested).
- CI: pnpm build/lint/test + a Tauri matrix (macOS universal, Linux x64/arm64, Windows, Android) with a prebuilt-assets check on macOS.

## 4. Architecture Comparison

| | Roomy | Chatto | Colibri |
|---|---|---|---|
| Client | Svelte 5 + TanStack Query | Svelte 5 + TanStack Query | SolidJS |
| Backend | Bun/TS appserver (transitional → Rust) | Go event-sourced (NATS JetStream) | Rust AppView |
| Media SFU | — | **LiveKit (external)** | **mediasoup (embedded)** |
| Signaling | — | ConnectRPC + LiveKit webhooks | Custom WS `voice.signal` (mediasoup protocol) |
| Call state | — | Durable room-aggregate EVT facts + projection + reconciliation | Ephemeral in-memory SFU + presence over sync socket |
| Presence | none today | Durable facts (room call events) | Off-protocol sync-socket events + Humming federation |
| Realtime transport | Single multiplexed WS (`sync.subscribe`): `#messageDiff`/`#invalidate`/`#roomMetadataDiff` frames | EVT stream + two-tier realtime events | Single WS `subscribeEvents` + separate voice signal WS |
| Room primitive | `space.roomy.channel` / `.thread` / `.page` labels | Rooms (one call per room) | Channel records with type (incl. `channel.voice`) |
| E2EE | (per-user crypto-shredding precedent, ADR-007-style) | Per-call LiveKit E2EE, KMS-backed, shredded | None (DTLS-SRTP only) |
| Moderation | roles exist | room membership gates calls (no dedicated perm — open question in FDR-016) | `voice.moderate` XRPC: server mute/deafen/disconnect |
| Test mode auth | `APPSERVER_TEST_MODE` + `X-Test-Did` header | `test_endpoints` build tag + bootstrap | n/a |
| Testing | 451 bun tests + 39 e2e factory tests; no browser E2E | Go unit (real NATS) + Vitest 3-project + Playwright real-binary + perf regression | Vitest pure functions + Rust unit; no SFU tests, no E2E |

**Key takeaways for Roomy**

1. **LiveKit external SFU, not embedded mediasoup.** Colibri's mediasoup is Linux-only, Rust-only, and adds heavy operational surface (announced IP, RTC port ranges, worker counts) to the appserver. Roomy's appserver is Bun/TS and explicitly transitional; embedding an SFU there is the wrong bet. LiveKit is a mature, well-documented external service; Chatto (a similar thin-client + server app) proves the integration pattern end to end. Roomy's appserver stays stateless w.r.t. media, matching its existing "appserver owns materialisation, not media" posture.
2. **Calls are room-scoped.** Roomy rooms already model channels and threads (kind derived from `space.roomy.*` labels). A voice room = a room labeled `space.roomy.voice` (or a `voice` flag on channel rooms). One active call per room; join/leave/permission semantics all inherit existing room machinery. This matches Chatto exactly and Colibri's channel-type approach.
3. **Durable call facts + projection, webhook-driven truth.** Roomy already has a local SQLite event store + materialization + invalidation. Call lifecycle fits the existing pipeline: `call_started`/`call_joined`/`call_left`/`call_ended` events in the room stream → materialize into SQLite → invalidation signals → existing WS frames. User intent (join/leave RPCs) writes facts immediately (optimistic UI); LiveKit webhooks write confirmations; a reconciliation loop corrects drift. This is Chatto's ADR-009 model, which is strictly better than Colibri's in-memory presence for crash resilience and audit.
4. **Presence rides the existing sync socket.** Colibri's pattern — `voice_join`/`voice_state`/`voice_leave` client messages on the already-open sync WebSocket + broadcast presence events — keeps Roomy's single-multiplexed-socket model intact. Roomy has no presence system today; voice presence can be the first one, scoped to voice rooms (avoiding a general presence system in v1). No Humming equivalent needed — Roomy's appserver is centralized.
5. **Signaling socket options.** (a) Chatto-style: all call control is RPC + LiveKit handles signaling directly (simplest; client talks to LiveKit directly with the minted JWT); (b) Colibri-style: an appserver-mediated signaling WS. For LiveKit, (a) is right — the LiveKit SDK already does ICE/DTLS signaling; the appserver only needs to mint tokens and consume webhooks. No custom signaling protocol to build or test.
6. **E2EE.** Chatto's per-call LiveKit E2EE with key shredding is the model; Roomy has a crypto-shredding precedent (ADR-007 pattern in the SDK/appserver). Roomy has no KMS — an `ENCRYPTION_KEYS`-style SQLite table or env-managed key bucket suffices for v1, with the raw key never written to the event store.
7. **Graceful degradation** (Chatto): no LiveKit config → all voice RPCs return empty/null and app-lite hides voice UI. Cheap and clearly better than dead buttons.

## 5. Proposed Roomy Architecture (v1: voice-only)

### 5.1 Components

```
Browser (app-lite, Svelte 5)
  VoiceCallState (module per room, dynamic-import livekit-client)
    ├─ XRPC: voice.join / voice.leave / voice.getToken / voice.getParticipants / voice.getActiveCalls
    ├─ LiveKit Room (mic only, E2EE via ExternalE2EEKeyProvider)
    └─ Sync WS: sends voice_state (muted); receives voice_presence_event / voice_state_event
Appserver (Bun/TS)
  ├─ Voice RPC handlers (auth: membership via existing room authz)
  ├─ Durable call facts → SQLite materialisation → invalidation
  ├─ POST /webhooks/livekit (HMAC-validated) → fact writes
  ├─ Voice reconciler (periodic, single-leader lease): LiveKit listing vs projection
  └─ Config: LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_WEBHOOK_SECRET
LiveKit (external SFU, self-hosted or managed)
```

### 5.2 New XRPC surface (lexicons in `packages/appserver/lexicons/` + SDK schemas)

- `space.roomy.voice.getToken` (query) — roomId → `{ token, e2eeKey, callId }`. Requires room membership. Creates call session + per-call key on first join. `token` TTL ~5 min.
- `space.roomy.voice.join` (procedure) — records USER join intent fact (optimistic).
- `space.roomy.voice.leave` (procedure) — records USER leave intent fact.
- `space.roomy.voice.getParticipants` (query) — roomId → participants (from projection), with callId for stale-event guarding.
- `space.roomy.voice.getActiveCalls` (query) — space-scoped active call rooms for sidebar icons.
- `space.roomy.voice.moderate` (procedure, later phase) — server mute/deafen/disconnect (Colibri model, role-gated).
- Webhook route: `POST /webhooks/livekit` (HMAC via `livekit/protocol` webhook auth), handling `participant_joined` / `participant_left` / `room_finished`, filtering to our server's room-name prefix and excluding companion identities.

Wire additions to `packages/app-lite/src/lib/config.ts` (`APPSERVER_RPCS` + `OAUTH_SCOPE`) and the SDK transport registry.

### 5.3 Room model

Add room label `space.roomy.voice` (kind `voice` via existing `stripLabel`). Voice rooms are ordinary rooms: membership, roles, read access all inherited. Chat UI hidden for voice rooms; voice UI shown for them. (Alternative: a `voice` flag on channel rooms — decision point for Meri; label-as-kind is simpler and matches existing patterns.)

### 5.4 Durable events + materialisation

Reuse the existing sendEvents → event store → materialiser pipeline:

- Events (new kinds in the stream schema): `call_started`, `call_joined`, `call_left`, `call_ended` (room-scoped, with `callId`).
- Materialise into SQLite: `active_calls` / `call_participants` tables (per-space DBs, matching `per-space-dbs`).
- Invalidation: extend `inferSignals` so call events invalidate `voice.getParticipants` / `voice.getActiveCalls` / room metadata; presence/participant changes also emit a new `#voicePresenceDiff`-style frame or reuse `#invalidate` + `#roomMetadataDiff` (decision: a dedicated frame keeps participant lists live without HTTP refetch — Chatto pushes participant changes; Roomy's `#messageDiff` precedent supports a `#voiceDiff`).
- Call start/end surface as system rows in the room timeline (like Chatto's "X started a call in this room" with a Join action), reusing Roomy's system-message machinery.

### 5.5 Reconciliation

30 s ticker (Chatto's proven interval), single-leader lease (Roomy needs a small lease/lock — e.g. a SQLite advisory lock or a KV lease in the existing cache; Chatto uses a `MEMORY_CACHE` lease), listing LiveKit rooms/participants via the LiveKit API, appending RECONCILIATION-sourced correction facts. Consecutive-failure threshold (3) ends projected active calls. List failures must never block room leave (best-effort disconnect, reconcile later).

### 5.6 Presence over the sync socket

New client→server messages on `space.roomy.sync.subscribe`: `voice_state` (`{ roomId, muted, deafened }`); server→client frames: `voice_presence_event` (`{ roomId, did, event: join|leave }`) and `voice_state_event` (`{ roomId, did, muted, deafened }`), scoped to subscribers of that room topic (existing topic routing handles this). Member-list reconciliation: like Colibri's fix, treat the members snapshot from `voice.getParticipants` as source of truth and re-apply on reconnect.

### 5.7 Client (app-lite)

- `src/lib/voice/VoiceCallState.svelte.ts` modeled on Chatto's `voiceCall.svelte.ts` (but voice-only v1): dynamic-import `livekit-client`, `ExternalE2EEKeyProvider` + E2EE worker, mono mic capture (`AudioPresets.speech`, echo cancellation, noise suppression, DTX, RED), join/leave coalescing, compensating leave on connect failure, media-device failure classification → actionable toasts, `track.attach()` for remote audio.
- Room sidebar: voice room icon with active-call pulse; Voice panel component (`VoiceRoomPanel.svelte`): participant list with speaking indicators (audio-level cache at ~60 ms), mute/deafen controls, join/leave; call observer state for non-joined members (who's in the call + Join button).
- Sync integration: wire `voice_state` sends + presence frame handling into `sync.svelte.ts` / query cache (TanStack Query invalidation + a lightweight presence store).
- Config: `LIVEKIT_URL` exposure to the client (runtime config or the token response), feature-flag gate.

## 6. Testing & Verification Plan (Chatto model, adapted to Roomy)

Roomy's existing strengths: `APPSERVER_TEST_MODE` + `X-Test-Did` header bypass, `appserver.test.ts` factory smoke tests (451 bun tests), per-space SQLite. The plan extends these rather than inventing new machinery.

### 6.1 Appserver unit tests (bun test, :memory: DB — existing convention)

- Token generation: valid LiveKit JWT shape, metadata embedding, TTL, membership enforcement (403 for non-members), no-LiveKit-config → null.
- Fact model: join/leave idempotency, USER vs LIVEKIT dedup, stale-callId events ignored, call lifecycle (start on first join, end on final leave), key creation/shredding on end (with failure injection).
- Reconciliation: fake LiveKit lister (interface, mirroring Chatto's `liveKitParticipantLister`): projection corrections, missing/empty room ends call, list-failure threshold behavior (defer < 3, end at 3), lease single-leader, conflicts rechecked.
- Webhook handler: HMAC validation (reject bad signature), room-name parsing/routing, companion-publisher exclusion, test-endpoint bypass path.
- Materialisation + invalidation: call events → SQLite tables → `inferSignals` → invalidation frames.
- Presence: `voice_state` message → scoped broadcast.

### 6.2 Test webhook endpoints (Chatto ADR-020 model)

When `APPSERVER_TEST_MODE=true`, register `/webhooks/test/call-join` and `/webhooks/test/call-leave` (and `call-room-finished`) that bypass LiveKit HMAC and invoke the same core handlers the real webhook calls. Structurally absent unless test mode is on — same guarantee as Chatto's build tag, using the flag Roomy already has.

### 6.3 Frontend unit tests (Vitest)

- `VoiceCallState.svelte.ts` spec with a fully mocked `livekit-client` module (Chatto's pattern): E2EE-before-connect ordering, mono capture, join-muted-on-mic-failure, join/leave coalescing, compensating leave, presence event handling, stale-call guards. Mock the livekit module with controllable failure gates.
- Presence reducer / participant-list logic as pure functions with dedicated tests (Colibri's `voice-presence.test.ts` pattern).
- Component tests for the voice panel (happy-dom or browser-mode Vitest) covering observer vs participant states, mute/deafen controls, speaking indicators.

### 6.4 E2E (extend existing appserver E2E harness)

- Boot the real appserver factory in test mode with fake LiveKit config (token gen is pure JWT — no live server needed).
- Drive join/leave via the test webhook endpoints; assert UI: room icon appears/disappears, participant lists update across two clients, timeline rows ("started a call" / "call ended") appear without reload, observer panel shows Join, leave removes participants.
- Assert `livekitUrl` surfaces in runtime config.
- Media (real WebRTC) remains manual/local verification, documented as such (Chatto's explicit stance).

### 6.5 CI

- Extend the existing CI (TASK-55 in progress) with the new bun test files + Vitest + the E2E harness job. No real LiveKit in CI.
- Optional later: performance regression for participant-list rendering at scale (Chatto's large-server benchmark precedent), media E2E job with ffmpeg for screen-share fixtures.

## 7. Milestones

- **Phase 1 — Signaling + presence (v1 core):** voice room kind, join/leave/getToken/getParticipants/getActiveCalls RPCs, durable call facts + materialisation + invalidation, LiveKit webhook handler, test webhook endpoints, sync-socket presence, sidebar icon + observer panel. Mic connect works end to end.
- **Phase 2 — Call UX polish:** participant cards + speaking indicators + audio-level cache, mute/deafen, join/leave sound cues, timeline call rows, reconnect/coalescing hardening, E2EE key lifecycle hardening.
- **Phase 3 — Moderation & hardening:** `voice.moderate` (server mute/deafen/disconnect, role-gated), membership-change cleanup (leave room/kick/ban/delete → auto-leave + media teardown), reconciliation failure thresholds tuned for production.
- **Phase 4 — Video & screen share:** camera tiles, screen share (browser picker), simulcast/dynacast settings; optional native companion later.
- **Phase 5 — Ops:** LiveKit deployment docs (self-hosted + managed), TURN for restrictive networks, `LIVEKIT_*` env wiring in Railway, monitoring (call quality metrics).

## 8. Open questions for Meri

1. **Voice room model**: new `space.roomy.voice` room kind vs a `voice` flag on channel rooms? (Recommendation: room kind — simpler, matches Chatto.)
2. **E2EE scope for v1**: always-on per-call E2EE (Chatto) vs DTLS-only initially (Colibri)? E2EE adds key-management work but matches Roomy's privacy posture. (Recommendation: E2EE from the start — Chatto proves it, and retrofitting E2EE later breaks media compatibility.)
3. **LiveKit hosting**: self-hosted (Docker) vs managed (LiveKit Cloud)? Affects deployment phase, not architecture.
4. **Presence generality**: voice-only presence now (recommended) vs a general presence system (online/away/dnd) that voice rides on later?
5. **Dedicated voice permission** (Chatto's open question): should voice rooms have a separate `voice.join` permission beyond room membership? (Recommendation: room membership suffices for v1.)

## 9. References

- Chatto: `docs/adr/ADR-009-webhook-driven-voice-call-state.md`, `docs/adr/ADR-020-build-tag-test-endpoints.md`, `docs/fdr/FDR-016-voice-calls.md`, `cli/internal/core/voice.go`, `cli/internal/core/call_model.go`, `cli/internal/http_server/webhooks.go`, `apps/frontend/src/lib/state/server/voiceCall.svelte.ts`, `apps/frontend/e2e/voice-call.spec.ts`, `apps/frontend/e2e/fixtures/server.ts`, `.github/workflows/ci.yml`, `mise.toml` (`build-e2e-server`).
- Colibri: `packages/client/src/contexts/VoiceChat.tsx`, `packages/client/src/utils/voice-presence.ts`, `packages/client/src/utils/voice-device.ts`, `apps/website/src/content/docs/docs/architecture/appview.mdx` (Humming), `apps/website/src/content/docs/docs/self-hosting/getting-started.mdx` (Voice), `apps/website/src/content/docs/docs/specification/appview.mdx` (voice_join/leave, Hum envelope); AppView: `src/sfu.rs`, `src/xrpc/social/colibri/voice/signal_handler.rs`, `src/xrpc/social/colibri/voice/moderate_handler.rs`, `src/lib/voice_events.rs`, `src/lib/voice_control.rs`.
- Roomy: `packages/appserver/docs/plans/appserver-architecture.md`, `packages/appserver/src/sync/handler.ts`, `packages/appserver/src/invalidation/types.ts`, `packages/appserver/src/handlers/space.roomy.room.getMetadata.ts` (kind mapping), `packages/app-lite/src/lib/sync.svelte.ts`, `packages/app-lite/src/lib/config.ts` (APPSERVER_RPCS/scope), `packages/sdk/src/schemas/frames/*` (WS frame schemas).
