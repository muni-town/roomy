# Native Push — Plugin Distribution, Upstream Edits, and Rollout

**Date:** 2026-10-01
**Status:** Research notes — no code changed. Action required before Android push or any fork.
**Related:** `native-push-plan.md` (the implemented transports and client wiring this follows on from), `web-push-plan.md`.
**Audience:** the agent (or human) planning the upstream/plugin edits and the production rollout.

This document records findings that are *not* in `native-push-plan.md`: how the
native push plugin is distributed, what is actually broken in it and where, why
desktop/macOS is not a config toggle, and the production credential/provisioning
steps. Everything below is anchored to a path + line that was read; anything not
directly observed is marked `[INFERENCE]`.

---

## 1. What the plugin is, and how it ships

Two artifacts, from one upstream repo — `github.com/yanqianglu/tauri-plugin-mobile-push`
(Apache-2.0 / MIT, ~10 stars, 1 fork, first release 2026-03):

| Artifact | Registry | Pinned in this repo | Consumed at |
|---|---|---|---|
| Rust crate `tauri-plugin-mobile-push` | crates.io (0.1.0, 0.1.3, **0.1.4** — 2026-04-18) | `"0.1"` | `packages/app-lite/src-tauri/Cargo.toml:38` |
| JS `tauri-plugin-mobile-push-api` | npm | `^0.1.4` | `packages/app-lite/package.json:38` |

**The load-bearing property:** the native code ships *inside the crate source
tree*, not as a prebuilt artifact. The crate's `Cargo.toml` declares

```toml
[package.metadata.tauri-plugin]
android-src = "android"
ios-src = "ios"
```

`tauri-plugin`'s build script reads that metadata and copies `android/` and
`ios/` out of the crate source into `gen/`. Consequences:

- Any fork **must** be consumed as a source dependency (git or path). A vendored
  `.aar`, a compiled artifact, or a patched `gen/` tree will not carry the
  native sources.
- `packages/app-lite/scripts/copy-android-assets.sh` is **not** an escape hatch: it only
  overwrites the files tauri-cli itself generates (`app/build.gradle.kts`,
  `app/src/main/AndroidManifest.xml`, root `build.gradle.kts`) from
  `src-tauri/android/`. It cannot patch the crate's Kotlin sources — those are
  copied by the crate's build script after `tauri android init`.
- The crate sets `links = "tauri-plugin-mobile-push"`. Two packages claiming that
  `links` key cannot coexist in one graph, so a fork must *replace* the crates.io
  dependency outright — never sit beside it.

---

## 2. Fork mechanics (decision: fork under `muni-town`, consume via `git` + `rev`)

### Fork target

Fork to **`muni-town/tauri-plugin-mobile-push`**, not a personal account:

- This is a load-bearing dependency of a shipped iOS app; the upcoming edit is
  Kotlin/Rust in the crate. Org ownership survives staff changes.
- Org CI secrets are already in play for this build (`muni-town/roomy` repo
  secrets), so the fork lives where the build does.
- No muni-town fork exists yet (org repo search for "push" → 0 results). The only
  current fork is `TurannLabs/tauri-plugin-mobile-push` (created 2026-08,
  untouched) — do not depend on it.

### Consuming it — no crates.io publish

Replace `packages/app-lite/src-tauri/Cargo.toml:38` with:

```toml
[target.'cfg(any(target_os = "android", target_os = "ios"))'.dependencies]
tauri-plugin-mobile-push = { git = "https://github.com/muni-town/tauri-plugin-mobile-push", rev = "<full-sha>" }
```

- **Pin `rev`, not `branch`.** A git dependency carries no semver, so `rev` is the
  only thing making the mobile build reproducible.
- **Do not use `[patch.crates-io]`.** It is honoured only in a workspace-root
  manifest. `packages/app-lite/src-tauri` is a standalone package: there is no
  root `Cargo.toml` and no `[workspace]` anywhere (verified). A direct git
  dependency is simpler and avoids patch-resolution surprises with the `links` key.
- **Publishing to crates.io would hurt.** Crate names are first-come, so the fork
  cannot publish under `tauri-plugin-mobile-push`; it would need a new name, which
  every consumer must then change in the dependency line. Not worth it for a
  single-repo fork. `git` + `rev` is the mechanism upstream's own README offers.

### Keep the npm side on upstream

The Android defect is Rust-side (see §3), and it does **not** change the JS
surface (`requestPermission`, `getToken`, `onTokenRefresh`,
`onNotificationReceived`, `onNotificationTapped` — see
`github.com/yanqianglu/tauri-plugin-mobile-push/blob/main/guest-js/index.ts`).
So `tauri-plugin-mobile-push-api@^0.1.4` from npm keeps working unchanged.

Only fork npm if the JS API changes; then use
`"tauri-plugin-mobile-push-api": "github:muni-town/tauri-plugin-mobile-push#path:/guest-js"`.
Note `guest-js/dist/` is **committed** in the upstream repo, so a JS fork must
rebuild and commit `dist` or the import resolves to stale output.

**Net effect: one dependency swapped, not two.**

### `Cargo.lock` is stale and must be regenerated

`packages/app-lite/src-tauri/Cargo.lock` is tracked in git, last touched by
`2279a7b2d` (the desktop-updater PR) — i.e. **before** the push PR. It contains
**zero** occurrences of `tauri-plugin-mobile-push`, and the
`[[package]] name = "app"` dependency list in it omits the crate entirely.

That the lock *does* record target-gated dependencies is proven by android-only
`jni` (present, twice) and macOS-only `objc2` — so the absence is not a
host-target artifact; the lock simply predates the dependency.

- **Verified, not inferred:** `cargo metadata --locked` in
  `packages/app-lite/src-tauri` fails outright —

  ```
  error: cannot update the lock file .../Cargo.lock because --locked was passed to prevent this
  ```

  So `--locked`/`--frozen` on a mobile target breaks today. Regenerate and commit
  the lock alongside the dependency change (see the toolchain note below).
- CI passes no `--locked`/`--frozen` to cargo (only pnpm uses
  `--frozen-lockfile`), and `pnpm tauri android build --apk` /
  `pnpm dlx @tauri-apps/cli@2.12.0 ios build` run cargo unlocked — so CI
  self-heals today. Do not rely on that after the fork swap.

#### Toolchain for regenerating the lock

`cargo` is not on the default `PATH` in this container, but a working toolchain
is installed under `/workspace/.toolchain` (Rust 1.98.0 + Android targets; see
`/workspace/.toolchain/BUILD-NOTES.md`):

```bash
export RUSTUP_HOME=/workspace/.toolchain/rustup CARGO_HOME=/workspace/.toolchain/cargo
export PATH="$CARGO_HOME/bin:$PATH"
cd packages/app-lite/src-tauri
cargo metadata --format-version 1 >/dev/null   # or `cargo generate-lockfile`
```

The container has network access to crates.io (the index updated during the check
above), so the regeneration can run here and the resulting lock be committed from
this workspace.

---

## 3. What is broken in 0.1.4, and exactly where to fix it

Upstream `src/commands.rs` (verified by reading the file on `main`):

```rust
#[cfg(target_os = "ios")]  { /* real FFI: mobile_push_request_permission() */ }
#[cfg(not(target_os = "ios"))] { Ok(PermissionResponse { granted: false }) }   // request_permission
#[cfg(not(target_os = "ios"))] { Ok(TokenResponse { token: String::new() }) }  // get_token
```

and `src/lib.rs` registers those Rust handlers:

```rust
.invoke_handler(tauri::generate_handler![
    commands::request_permission,
    commands::get_token,
    commands::register_listener
])
```

### Defect A — Android commands are shadowed by the crate's own Rust stubs

The Rust `request_permission`/`get_token` commands are registered on every
target. On Android Tauri dispatches the crate's Rust command before the native
Kotlin plugin, so the `#[cfg(not(target_os = "ios"))]` arms win and always resolve
`{ granted: false }` / `{ token: "" }`.

Confirmed by the Kotlin side
(`android/.../MobilePushPlugin.kt`), which implements real `getToken` via
`FirebaseMessaging.getInstance().token` and `requestPermissions` via
`requestPermissionForAlias` — none of which is ever reached.

**Fix direction:** make the Rust commands defer to the native plugin on Android
(`run_mobile_plugin`) instead of short-circuiting, i.e. narrow the stub arms to
`#[cfg(desktop)]` and let Android fall through to Kotlin. `[INFERENCE]` — note also
that the Kotlin command is `requestPermissions` (plural, the framework's
permission-override name) while the JS/Rust name is `request_permission`; if the
Rust handler is removed without renaming, the invoke may not resolve at all.
Confirm the dispatch/name mapping against the Tauri v2 plugin dispatch before coding.

### Defect B — event listeners never fire (both platforms)

- Android: `register_listener` is a Rust **no-op** returning `Ok(())`, whose
  comment states events are "not yet delivered through this path".
- iOS: the plugin's own README states `trigger()` cannot reach the webview.

The client already documents this at `packages/app-lite/src/lib/native-push.ts:18-36`
and installs the listeners best-effort
(`installNativePushListeners`, `native-push.ts:354-405`). Nothing may depend on
tap-through.

**Fix direction:** implement `register_listener` so it actually bridges native
events to the webview on both platforms, then rely on the routing code that
already exists (`routeFromEvent`/`navigateFromEvent`, `native-push.ts:288-333`).

### Defect C — no desktop/macOS implementation at all

Upstream `src/lib.rs` selects `#[cfg(desktop)] mod desktop` — and
`src/desktop.rs` is an empty stub whose own comment says commands "return stub
values on desktop (push notifications are mobile-only)". The README's platform
table lists Desktop as "No-op (stub values)".

So macOS is **not** a matter of flipping cfg flags; there is no APNs
implementation for macOS to enable. See §4.

### What already works

iOS `requestPermission()` and `getToken()` work, via direct `@_cdecl` FFI into
Swift (bypassing Tauri's `run_mobile_plugin` dispatch entirely). The token is the
lowercase-hex APNs device token, registered with `kind: "apns"`.

---

## 4. Desktop / macOS: not close, and not a config change

If the question is "can the desktop builds receive APNs?", the answer is no, and
four independent gates would each have to change — one of which is missing code,
not a setting.

1. **Plugin not registered on desktop.** `packages/app-lite/src-tauri/src/lib.rs:16-25`
   registers the plugin inside `#[cfg(mobile)]` (android + iOS only). The Cargo
   dependency is likewise gated to
   `cfg(any(target_os = "android", target_os = "ios"))`
   (`Cargo.toml:37-38`).
2. **Client refuses to classify desktop as a push platform.**
   `nativePushPlatform()` (`native-push.ts:125-129`) returns `null` unless the
   shell reports `ios`/`android`; the type is literally
   `NativePushPlatform = "ios" | "android"` (`native-push.ts:46`). Because
   `nativePushSupported()` is false on macOS, every entry point in
   `push.svelte.ts` silently takes the **Web Push** path instead.
3. **Capability is desktop-excluded on purpose.**
   `capabilities/mobile.json` sets `"platforms": ["android", "iOS"]`, with an
   in-file comment explaining that tauri-build skips a capability whose
   `platforms` exclude the target *before* validating the unknown
   `mobile-push:default` permission — that skip is what keeps desktop builds from
   failing. Adding macOS requires making the Rust dependency unconditional for
   macOS first.
4. **No macOS implementation exists** (Defect C above), plus macOS would need the
   `aps-environment` entitlement in the notarised `.app`, with the mac App ID
   registered for Push Notifications. The release workflow has no desktop
   analogue of the iOS entitlement step (`.github/workflows/release-tauri.yml:414-427`).

Windows and Linux have no APNs path under any change — Windows would be WNS,
Linux a browser-engine push service; neither exists in this repo.

**Recommendation:** scope native push to **iOS only**, matching what the push PR
itself concluded. Treat macOS as a separate feature requiring a real
Swift/AppKit APNs implementation upstream.

---

## 5. Production rollout: APNs credentials and provisioning

### 5.1 App ID capability

The App ID `space.roomy` (must match `identifier`) needs **Push Notifications**
enabled. *Broadcast Push Notifications* / Live Activities are **not** used by this
codebase: the only APNs request built is an alert push to
`/3/device/<device token>` with `apns-push-type: alert`
(`packages/appserver/src/push/transports/apn.ts:186-204`); repo-wide there is no
Live Activity, ActivityKit, broadcast channel id, or `aps-environment` usage
beyond the entitlement step. Skip the broadcast capability.

### 5.2 Regenerating the provisioning profile

An existing profile keeps its old entitlement allowlist; enabling the capability
does not propagate to it.

1. Identifiers → App ID `space.roomy` → confirm Push Notifications is checked.
2. Profiles → the **App Store Connect** distribution profile → Edit → Save
   (regenerates with current entitlements). If the capability still doesn't appear,
   delete and recreate the profile.
3. Confirm it is linked to the **Apple Distribution** certificate held in
   `APPLE_CERTIFICATE`. The workflow asserts the `.p12` holds exactly one Apple
   Distribution identity and no Development cert
   (`release-tauri.yml:257-304`).
4. Verify before uploading — this is the exact thing export fails on:

   ```bash
   security cms -D -i ~/Downloads/space_roomy.mobileprovision \
     | plutil -extract Entitlements xml1 -o - - | grep -A1 aps-environment
   ```

   Must print `production`. The workflow writes `production` into the
   entitlements file (`release-tauri.yml:424`); the profile is what authorises it.
5. Update the `APPLE_MOBILE_PROVISION` repo secret with
   `base64 -i <profile>.mobileprovision` (mapped to `IOS_MOBILE_PROVISION` at
   `release-tauri.yml:328` and `:489`). No device list to re-add — App Store
   Connect profiles are not device-scoped, unlike Ad Hoc.

### 5.3 Appserver env

Read from `process.env` at transport import
(`packages/appserver/src/push/transports/apn.ts:282-293`); they belong to the
appserver deployment (per `.env.example`), not the app repo or CI.

| Var | Source | Notes |
|---|---|---|
| `APNS_AUTH_KEY` | Developer portal → **Keys** → + → enable "Apple Push Notifications service (APNs)" | The `.p8` contents; downloadable **once**. |
| `APNS_KEY_ID` | The key's row / `AuthKey_<KEYID>.p8` filename | 10 chars; sent as JWT `kid`. |
| `APNS_TEAM_ID` | **Membership details** | 10 chars; the `iss` claim. |
| `APNS_TOPIC` | Defaults to `space.roomy` | The bundle id. |
| `APNS_ENVIRONMENT` | Defaults to `production` | Selects `api.push.apple.com`. |

**Two easy-to-confuse `.p8` files:** `APPLE_API_KEY` (App Store Connect API key,
from App Store Connect → Users and Access → Integrations) is *not*
`APNS_AUTH_KEY` (Developer portal → Keys, with the APNs service enabled). Both are
ES256 `.p8`; both parse; they are not interchangeable. There is no certificate
(`.p12`) path in this codebase at all — `apn.ts:109-124` builds a provider JWT from
the `.p8`.

**Encoding.** `authKeyDer()` (`apn.ts:94-107`) accepts raw PEM, PEM with literal
`\n`, or base64-of-PEM. Prefer base64 for a single-line secret store:
`base64 -i AuthKey_<KEYID>.p8`. A value that is neither PEM nor base64-of-PEM
makes `isConfigured()` return false (`apn.ts:208-219`), which surfaces as
`skipped` deliveries in `space.roomy.admin.push.getStats` — a silent-looking
config error, not a crash.

### 5.4 Two operational traps

- **A wrong `APNS_TOPIC` prunes devices.** `DeviceTokenNotForTopic` is in
  `PRUNE_REASONS` (`apn.ts:59-65`), maps to `gone` (`apn.ts:258`), and the
  dispatcher prunes the row. A topic typo silently unsubscribes the device.
- **Credential changes need a process restart.** The transport caches the imported
  key and the minted provider token for the process lifetime, and only drops the
  token on `403 ExpiredProviderToken` (`apn.ts:85-87`, `:262-266`).
  `403 InvalidProviderToken` does **not** refresh it, so editing env vars is not
  enough; redeploy/restart.

### 5.5 Triage: `403 InvalidProviderToken`

Apple: "the provider token is not valid, or the token signature can't be
verified". It maps to `retry`, not `gone` (`apn.ts:258-271`) — nothing is pruned.
Cause is one of, ranked:

1. `APNS_KEY_ID` does not match the `.p8` in `APNS_AUTH_KEY` (several keys created).
2. The App Store Connect API key was pasted instead of the APNs key (see §5.3).
3. `APNS_TEAM_ID` is wrong (must be the Membership-details team, not necessarily the
   identifier's App ID Prefix).
4. Environment mismatch: a sandbox-scoped key against the production host.

See `native-push-plan.md` → "Open questions" for the remaining follow-ups
(per-transport rate budgets, Notification Service Extension, badge counts).

---

## 6. Verification recipes

```bash
# What the provider JWT actually contains (no network). Runs the same jwt.ts the
# transport uses; compare `kid` to the .p8 filename and `iss` to Membership details.
cd /workspace
APNS_AUTH_KEY='...' APNS_KEY_ID='...' APNS_TEAM_ID='...' bun -e '
import { importSigningKey, pemToDer, signJwt } from "./packages/appserver/src/push/transports/jwt.ts";
const raw = process.env.APNS_AUTH_KEY;
const pem = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
const der = pemToDer(pem.includes("-----BEGIN") ? pem : Buffer.from(pem, "base64").toString("utf8"));
const jwt = await signJwt("ES256", await importSigningKey("ES256", der),
  { alg: "ES256", kid: process.env.APNS_KEY_ID },
  { iss: process.env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) });
console.log("header:", Buffer.from(jwt.split(".")[0], "base64url").toString());
console.log("claims:", Buffer.from(jwt.split(".")[1], "base64url").toString());
console.log("jwt:", jwt);
'

# Raw APNs answer for one device (use a PRODUCTION token from a TestFlight build).
curl -v --http2 \
  -H "authorization: bearer <jwt from above>" \
  -H "apns-topic: space.roomy" -H "apns-push-type: alert" \
  -d '{"aps":{"alert":"diag"}}' \
  https://api.push.apple.com/3/device/<64-hex device token>
```

Server-side diagnostics: `space.roomy.admin.push.getStats` (per-transport
`transportsConfigured`, plus lifetime counters) and
`space.roomy.admin.push.testSend` (per-endpoint delivery result, and the path that
prunes on `gone`).

---

## 7. Decisions to make

1. **Fork location:** `muni-town/tauri-plugin-mobile-push` — assumed here; confirm
   with the maintainers before creating.
2. **Android fix ownership:** fix upstream (in the fork) vs. moving the token path
   into this repo's own Tauri command (the alternative named in
   `native-push-plan.md` → "Open questions"). A fork is required either way for the
   upstream route; only the in-repo command avoids the fork, and it would still
   need the plugin registered.
3. **npm fork:** only if the JS surface changes (§2).
4. **Upstream the fixes?** If the fixes are generally useful, contribute them back
   to `yanqianglu/tauri-plugin-mobile-push` and drop the fork later; the `rev` pin
   makes that a one-line change.
5. **macOS:** defer (§4) unless a real AppKit APNs implementation is in scope.
