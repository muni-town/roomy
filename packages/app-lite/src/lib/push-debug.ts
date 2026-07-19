/**
 * Dev-only debug hook for web push, exposed on `window.roomyPush`.
 *
 * Phase 1 ships the push plumbing with no settings UI yet (the
 * `UpdateRhythmChooser` + notifications settings page land in Phase 2). To
 * run the Phase 1 end-to-end Busy test manually, open the browser console and
 * drive the pipeline from here:
 *
 *   await window.roomyPush.subscribe()                 // (re)register this device
 *   await window.roomyPush.setDefault("busy")          // user-wide default
 *   await window.roomyPush.setSpace("<spaceId>", "busy") // per-space override
 *   await window.roomyPush.getPrefs()                  // read current prefs
 *
 * Then post a message from another account in a space the busy user is a
 * member of — a real notification should appear. All calls go through the
 * authenticated `px()` client, so the user must be logged in.
 *
 * Gate: dev builds only (`import.meta.env.DEV`). No-op in production.
 */

import { px } from "$lib/auth.svelte";
import { ensurePushSubscription, base64UrlToUint8Array } from "$lib/push.svelte";

const DEV = import.meta.env.DEV;

type PushLevel = "silent" | "quiet" | "engaged" | "busy";

interface PushDiagnostics {
  timestamp: string;
  browser: {
    userAgent: string;
    platform: string;
    language: string;
  };
  pushSupport: {
    serviceWorker: boolean;
    pushManager: boolean;
    notifications: boolean;
  };
  notificationPermission: NotificationPermission;
  serviceWorker: {
    registered: boolean;
    scope: string | null;
    active: boolean;
    installing: boolean;
    waiting: boolean;
  } | null;
  subscription: {
    endpoint: string;
    pushService: string;
    expirationTime: number | null;
    hasKeys: boolean;
  } | null;
  vapidKey: {
    configured: boolean;
    length: number | null;
  } | null;
  featureFlagEnabled: boolean | null;
  lastRegisteredEndpoint: string | null;
}

interface RoomyPushDebug {
  subscribe: () => Promise<void>;
  testSubscribe: () => Promise<PushSubscription>;
  getPrefs: () => Promise<unknown>;
  setDefault: (level: PushLevel) => Promise<void>;
  setSpace: (spaceId: string, level: PushLevel) => Promise<void>;
  diagnostics: () => Promise<PushDiagnostics>;
}

/** Install `window.roomyPush` in dev builds. Safe to call repeatedly. */
export function installPushDebug(): void {
  if (!DEV) return;
  if (typeof window === "undefined") return;

  const api: RoomyPushDebug = {
    async subscribe() {
      await ensurePushSubscription();
    },
    async testSubscribe() {
      // Raw subscribe with the real VAPID key, surfacing the exact error so
      // we can tell whether `pushManager.subscribe` hangs, rejects with a
      // network error (push service unreachable), or rejects with a key
      // format error. Bypasses ensurePushSubscription's catch.
      const res = await px().query("space.roomy.push.getVapidPublicKey", {});
      const key = res.publicKey;
      if (!key) throw new Error("VAPID public key not configured on appserver");
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        console.info("[push.testSubscribe] reusing existing subscription:", existing.endpoint);
        return existing;
      }
      const applicationServerKey = base64UrlToUint8Array(key);
      console.info("[push.testSubscribe] calling pushManager.subscribe…");
      const sub = await Promise.race([
        reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey as BufferSource,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "pushManager.subscribe timed out after 20s — browser can't reach its push service (Chromium build without Google FCM keys, or GCM channel on port 5228 blocked)",
                ),
              ),
            20_000,
          ),
        ),
      ]);
      console.info("[push.testSubscribe] subscribe OK:", sub.endpoint);
      return sub;
    },
    async getPrefs() {
      return px().query("space.roomy.push.getPreferences", {});
    },
    async setDefault(level) {
      await px().procedure("space.roomy.push.setPreferences", {
        default: level,
      });
    },
    async setSpace(spaceId, level) {
      await px().procedure("space.roomy.push.setPreferences", {
        spaceId,
        level,
      });
    },
    async diagnostics() {
      const now = new Date().toISOString();
      const supports = {
        serviceWorker: "serviceWorker" in navigator,
        pushManager: "PushManager" in window,
        notifications: typeof Notification !== "undefined",
      };

      let swInfo: PushDiagnostics["serviceWorker"] = null;
      if (supports.serviceWorker) {
        try {
          const reg = await navigator.serviceWorker.ready;
          swInfo = {
            registered: true,
            scope: reg.scope,
            active: reg.active !== null,
            installing: reg.installing !== null,
            waiting: reg.waiting !== null,
          };
        } catch {
          swInfo = { registered: false, scope: null, active: false, installing: false, waiting: false };
        }
      }

      let subInfo: PushDiagnostics["subscription"] = null;
      if (swInfo && supports.pushManager) {
        try {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            let pushService = "unknown";
            try {
              pushService = new URL(sub.endpoint).hostname;
            } catch { /* leave as unknown */ }
            subInfo = {
              endpoint: sub.endpoint,
              pushService,
              expirationTime: sub.expirationTime,
              hasKeys: !!sub.toJSON().keys?.p256dh,
            };
          }
        } catch { /* leave null */ }
      }

      let vapidInfo: PushDiagnostics["vapidKey"] = null;
      let featureFlag: boolean | null = null;
      try {
        const res = await px().query("space.roomy.push.getVapidPublicKey", {});
        const key = typeof res.publicKey === "string" ? res.publicKey : "";
        vapidInfo = { configured: key !== "", length: key ? key.length : null };
      } catch { vapidInfo = { configured: false, length: null }; }

      try {
        const flagsRes = await px().query("space.roomy.getFlags", {});
        const flags = Array.isArray(flagsRes.flags) ? flagsRes.flags : [];
        featureFlag = flags.includes("push-notifications");
      } catch { featureFlag = null; }

      const result: PushDiagnostics = {
        timestamp: now,
        browser: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language,
        },
        pushSupport: supports,
        notificationPermission: typeof Notification !== "undefined" ? Notification.permission : "default",
        serviceWorker: swInfo,
        subscription: subInfo,
        vapidKey: vapidInfo,
        featureFlagEnabled: featureFlag,
        lastRegisteredEndpoint: localStorage.getItem("roomy.push.lastEndpoint"),
      };
      console.info("[push] diagnostics:", result);
      return result;
    },
  };

  (window as unknown as { roomyPush: RoomyPushDebug }).roomyPush = api;
  console.info("[push] dev debug hook ready: window.roomyPush", api);
}