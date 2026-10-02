/**
 * Native (iOS/Android) push registration for the Tauri shells.
 *
 * The web build talks to the browser Push API (see `push.svelte.ts`); inside a
 * Tauri shell there is no `PushManager`, so the device token comes from the
 * `tauri-plugin-mobile-push` plugin instead. This module owns that path and is
 * the only place that touches the plugin — every plugin access goes through a
 * dynamic `import(...)` (erased from the web bundle; see {@link loadPlugin}),
 * and every entry point is guarded and non-throwing, because push is a
 * progressive enhancement.
 *
 * Registration uses the same XRPC procedure as web push
 * (`space.roomy.push.registerSubscription`), with the device token in
 * `endpoint` and `kind` naming the transport (`apns` on iOS, `fcm` on
 * Android). Native tokens carry no `keys` — the appserver requires those for
 * `webpush` only.
 *
 * ## Plugin caveats (tauri-plugin-mobile-push 0.1.4)
 *
 * - **Android is not functional in this plugin build.** The crate registers
 *   Rust `#[tauri::command]` handlers for `request_permission`/`get_token`
 *   via `generate_handler!`, and Tauri runs `extend_api` before native plugin
 *   dispatch, so those Rust stubs always win over the Kotlin ones and resolve
 *   `{ granted: false }` / `{ token: "" }`.
 *   {@link ensureNativeSubscription} therefore treats an empty token as a
 *   failure instead of registering an empty endpoint, which the appserver
 *   would store and then fail to deliver to forever.
 * - **The event listeners are non-functional on both platforms.**
 *   `register_listener` is shadowed by a Rust no-op on Android, and on iOS the
 *   plugin's `trigger()` cannot reach the webview. {@link installNativePushListeners}
 *   is therefore best-effort: it registers cleanly and starts working if
 *   upstream fixes the plugin, but tap-through navigation MUST NOT be relied
 *   on, and a failure to install is swallowed.
 * - **iOS `requestPermission()` and `getToken()` do work** (they go through
 *   the plugin's direct `@_cdecl` FFI): the token is the lowercase-hex APNs
 *   device token, registered with `kind: "apns"`.
 */

import type { PluginListener } from "@tauri-apps/api/core";
// Type-only: erased at build time, so the runtime module import stays dynamic.
import type { PushNotification } from "tauri-plugin-mobile-push-api";
import { goto } from "$app/navigation";
import { px } from "$lib/auth.svelte";

/** Platform that has a native push transport wired up. */
export type NativePushPlatform = "ios" | "android";

/** localStorage key for the last token we registered with the appserver. */
const LAST_NATIVE_TOKEN_KEY = "roomy.push.lastNativeToken";

/** Outcome of a native subscribe/unsubscribe attempt. */
export type NativePushOutcome =
  | { status: "ok" }
  | { status: "denied" }
  | { status: "unsupported" }
  | { status: "failed"; message: string };

/**
 * The slice of the push plugin we call. Named (rather than
 * `typeof import(...)`) so consumers see the contract, and so the dynamic
 * import's namespace object is checked against it structurally.
 */
interface MobilePushPlugin {
  requestPermission(): Promise<{ granted: boolean }>;
  getToken(): Promise<string>;
  onTokenRefresh(
    handler: (payload: { token: string }) => void,
  ): Promise<PluginListener>;
  onNotificationReceived(
    handler: (notification: PushNotification) => void,
  ): Promise<PluginListener>;
  onNotificationTapped(
    handler: (notification: PushNotification) => void,
  ): Promise<PluginListener>;
}

/**
 * Load the plugin.
 *
 * Dynamic on purpose: this module is imported by the web bundle too, where
 * the plugin (`invoke()` IPC against a shell that isn't there) must never be
 * evaluated. A static import cannot work here for that reason.
 */
function loadPlugin(): Promise<MobilePushPlugin> {
  return import("tauri-plugin-mobile-push-api");
}

/**
 * Read the platform out of the shell's `__TAURI__` global.
 *
 * `os` comes from the `os:default`-gated `os` plugin, whose startup script
 * installs `window.__TAURI__.os`. That global is not in the Tauri JS API's
 * type declarations (the app imports only some namespaces from the API
 * package), so it is read through `in`/`typeof` narrowing rather than a cast.
 */
function tauriOsPlatform(): unknown {
  if (typeof window === "undefined") return null;
  // Same runtime check the updater uses: the shell exposes `__TAURI__`
  // (config sets `withGlobalTauri: true`), the web app does not.
  if (!("__TAURI__" in window)) return null;
  const tauri = window.__TAURI__;
  if (typeof tauri !== "object" || tauri === null) return null;
  if (!("os" in tauri)) return null;
  const os = tauri.os;
  if (typeof os !== "object" || os === null) return null;
  if (!("platform" in os)) return null;
  const platform = os.platform;
  if (typeof platform !== "function") return null;
  try {
    return platform.call(os);
  } catch (e) {
    console.warn("[push:native] os.platform() threw:", e);
    return null;
  }
}

/**
 * The Tauri shell this app is running in, or `null` on the web — and on the
 * desktop targets, which report `macos`/`windows`/`linux` and are not push
 * targets in this change.
 *
 * `os.platform()` is synchronous (it reads a value injected at startup), so
 * this is safe to call during render.
 */
export function nativePushPlatform(): NativePushPlatform | null {
  const platform = tauriOsPlatform();
  if (platform === "ios" || platform === "android") return platform;
  return null;
}

/** Is this a Tauri shell with a native push transport? */
export function nativePushSupported(): boolean {
  return nativePushPlatform() !== null;
}

/** The token we last registered, if any (persisted across launches). */
export function lastNativeToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(LAST_NATIVE_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Register a native device token with the appserver. */
export async function registerNativeToken(token: string): Promise<void> {
  const platform = nativePushPlatform();
  if (platform === null) throw new Error("Not running in a native shell");
  // No `keys`: the appserver requires those for `webpush` only.
  await px().procedure("space.roomy.push.registerSubscription", {
    endpoint: token,
    kind: platform === "ios" ? "apns" : "fcm",
  });
  try {
    localStorage.setItem(LAST_NATIVE_TOKEN_KEY, token);
  } catch {
    // Persisting is a convenience (login-time re-register): a storage failure
    // must not fail the registration itself.
  }
}

/** Message for a caught error, with the XRPC status when the error carries one. */
function errorDetail(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (typeof e === "object" && e !== null && "statusCode" in e) {
    const statusCode = e.statusCode;
    if (typeof statusCode === "number") return `${message} (${statusCode})`;
  }
  return message;
}

/**
 * Ask for notification permission and register this device, prompted by an
 * explicit user gesture (the settings page's "Enable notifications" button).
 * Never throws — callers get a {@link NativePushOutcome}.
 */
export async function ensureNativeSubscription(): Promise<NativePushOutcome> {
  const platform = nativePushPlatform();
  if (platform === null) return { status: "unsupported" };

  let plugin: MobilePushPlugin;
  try {
    plugin = await loadPlugin();
  } catch (e) {
    console.warn("[push:native] could not load push plugin:", e);
    return { status: "failed", message: errorDetail(e) };
  }

  // Permission first, as a user gesture requires, and only an explicit
  // `granted: true` counts (the Android stub resolves `false`, and a missing
  // field must never read as granted).
  let granted = false;
  try {
    const result: unknown = await plugin.requestPermission();
    granted =
      typeof result === "object" &&
      result !== null &&
      "granted" in result &&
      result.granted === true;
  } catch (e) {
    console.warn("[push:native] requestPermission threw:", e);
    return { status: "failed", message: errorDetail(e) };
  }
  if (!granted) return { status: "denied" };

  let token: unknown;
  try {
    token = await plugin.getToken();
  } catch (e) {
    console.warn("[push:native] getToken threw:", e);
    return { status: "failed", message: errorDetail(e) };
  }

  // 0.1.4's Android commands are shadowed by Rust stubs that always resolve
  // the empty string. Registering that would store an endpoint the appserver
  // can never deliver to, so fail loudly instead.
  if (typeof token !== "string" || token.trim() === "") {
    const message =
      platform === "android"
        ? "Android push is not supported by this plugin build (no device token is issued)."
        : "The push plugin returned an empty device token.";
    console.warn("[push:native] empty device token:", message);
    return { status: "failed", message };
  }

  try {
    await registerNativeToken(token);
    console.info("[push:native] registered device token with appserver:", token);
    return { status: "ok" };
  } catch (e) {
    const message = errorDetail(e);
    console.error("[push:native] register failed:", message, e);
    return { status: "failed", message };
  }
}

/**
 * Unregister this device on logout / "Disable on this device" so the
 * appserver stops delivering to it. Best-effort — a network failure must not
 * block logout. Never throws.
 */
export async function clearNativeSubscription(): Promise<NativePushOutcome> {
  if (nativePushPlatform() === null) return { status: "unsupported" };
  const token = lastNativeToken();
  if (token === null) return { status: "ok" };
  try {
    await px().procedure("space.roomy.push.unregisterSubscription", {
      endpoint: token,
    });
    try {
      localStorage.removeItem(LAST_NATIVE_TOKEN_KEY);
    } catch {
      // Ignore: the row is gone on the server either way.
    }
    return { status: "ok" };
  } catch (e) {
    console.warn("[push:native] unregister failed:", e);
    return { status: "failed", message: errorDetail(e) };
  }
}

/** Where a notification should take the user. */
interface NativePushRoute {
  spaceId: string;
  roomId: string;
  messageId?: string;
}

/**
 * The `spaceId`/`roomId`/`messageId` an event carries, read defensively.
 *
 * The payload shape differs per platform and per notification type, and does
 * not match the plugin's `.d.ts`:
 *  - Android `notification-tapped` puts the FCM `data` keys at the top level.
 *  - Android `notification-received` nests them under `data`.
 *  - iOS delivers what the sender put in the APNs payload — our appserver
 *    sends the Roomy payload as a JSON string under `roomy` (see
 *    `packages/appserver/src/push/transports/apn.ts`).
 *
 * Every candidate that might carry the route is collected first — the event
 * value itself, its `data`, and the parsed `roomy` JSON string from either of
 * those (iOS flattens the APNs `userInfo` onto the event; Android nests the
 * FCM data map under `data`) — then the first one holding a usable
 * `spaceId`/`roomId` pair wins. Every read is guarded, so a payload of an
 * unexpected shape yields "no route" rather than a throw.
 */
function routeFromEvent(event: unknown): NativePushRoute | null {
  const data =
    typeof event === "object" && event !== null && "data" in event
      ? event.data
      : undefined;
  const candidates: unknown[] = [event, data];
  for (const source of [event, data]) {
    if (typeof source !== "object" || source === null) continue;
    if (!("roomy" in source) || typeof source.roomy !== "string") continue;
    try {
      candidates.push(JSON.parse(source.roomy));
    } catch {
      // Malformed JSON in `roomy` is not fatal — fall through to the other
      // candidates, and ultimately to "no route".
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    if (!("spaceId" in candidate) || !("roomId" in candidate)) continue;
    const { spaceId, roomId } = candidate;
    if (typeof spaceId !== "string" || typeof roomId !== "string") continue;
    const messageId = "messageId" in candidate ? candidate.messageId : undefined;
    return {
      spaceId,
      roomId,
      ...(typeof messageId === "string" ? { messageId } : {}),
    };
  }
  return null;
}

/** Navigate to the room (and message) an event refers to. */
function navigateFromEvent(event: unknown): void {
  try {
    const route = routeFromEvent(event);
    if (!route) return;
    const query = route.messageId
      ? `?message=${encodeURIComponent(route.messageId)}`
      : "";
    goto(`/${route.spaceId}/${route.roomId}${query}`);
  } catch (e) {
    // Never let a malformed payload throw into the plugin's event loop.
    console.warn("[push:native] could not route notification:", e);
  }
}

/** Unregister a plugin listener, swallowing the (expected) failure. */
async function disposeOne(listener: PluginListener): Promise<void> {
  try {
    await listener.unregister();
  } catch {
    // The plugin may already be gone; nothing left to release.
  }
}

/**
 * Install the native push listeners: token rotation → re-register with the
 * appserver, and notification received/tapped → deep-link into the room.
 *
 * Best-effort by design, and never throws: as noted at the top of this file,
 * the plugin's `register_listener` is shadowed by a Rust no-op on Android and
 * `trigger()` cannot reach the webview on iOS, so in 0.1.4 these callbacks may
 * never fire. Nothing else in the app may depend on tap-through working.
 * Returns a disposer that unregisters whatever was installed (no-op on web).
 */
export function installNativePushListeners(): () => void {
  if (!nativePushSupported()) return () => {};

  let disposed = false;
  const listeners: PluginListener[] = [];

  // Each listener registers independently: one failing must not stop the
  // others, and one that resolves after disposal is released immediately.
  const register = async (label: string, call: () => Promise<PluginListener>) => {
    try {
      const listener = await call();
      if (disposed) await disposeOne(listener);
      else listeners.push(listener);
    } catch (e) {
      console.warn(`[push:native] ${label} listener unavailable:`, e);
    }
  };

  void (async () => {
    let plugin: MobilePushPlugin;
    try {
      plugin = await loadPlugin();
    } catch (e) {
      console.warn("[push:native] could not load push plugin for listeners:", e);
      return;
    }
    await register("onTokenRefresh", () =>
      plugin.onTokenRefresh((payload) => {
        try {
          const token = payload?.token;
          if (typeof token !== "string" || token.trim() === "") return;
          void registerNativeToken(token).catch((e) => {
            console.warn("[push:native] re-register of rotated token failed:", e);
          });
        } catch (e) {
          console.warn("[push:native] token refresh handler failed:", e);
        }
      }),
    );
    await register("onNotificationReceived", () =>
      plugin.onNotificationReceived(navigateFromEvent),
    );
    await register("onNotificationTapped", () =>
      plugin.onNotificationTapped(navigateFromEvent),
    );
  })();

  return () => {
    disposed = true;
    for (const listener of listeners.splice(0)) void disposeOne(listener);
  };
}
