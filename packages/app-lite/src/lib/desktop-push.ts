/**
 * Desktop push over the appserver's SSE transport.
 *
 * Tauri backend listens to stream and sends notifications
 * (`src-tauri/src/push_stream.rs`). Js webview registers the endpoint,
 * starts/stops the stream, and mints auth tokens for tauri.
 */
import { goto } from "$app/navigation";
import { appserverServiceToken, px } from "$lib/auth.svelte";
import { getAppserverOrigin } from "$lib/appserver-origin";
import { tauriOsPlatform, type NativePushOutcome } from "$lib/native-push";
import { routeFromEvent, routeHref } from "$lib/push-route";

/** localStorage key for the registered endpoint id. */
const ENDPOINT_KEY = "roomy.push.desktopEndpoint";

// TODO: use `space.roomy.push.stream` once it is in the OAuth scopes.
// Until then the token borrows a granted method. The server ignores `lxm`.
const STREAM_TOKEN_LXM = "space.roomy.push.registerSubscription";

const TOKEN_REQUEST_EVENT = "push-stream-token-request";
const REJECTED_EVENT = "push-stream-rejected";
const NOTIFICATION_CLICKED_EVENT = "push-notification-clicked";

/** Minimum time between recovery attempts after a rejected stream. */
const RECOVERY_INTERVAL_MS = 60_000;
let lastRecoveryAt = 0;

export function desktopPushSupported() {
  const platform = tauriOsPlatform();
  if (typeof platform !== 'string') return false
  return ["macos", "windows", "linux"].includes(platform)
}

/** The endpoint id registered on this install, if any. */
export function lastDesktopEndpoint(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(ENDPOINT_KEY);
  } catch {
    return null;
  }
}

/** The saved endpoint id, or a new one from Rust, saved. */
async function endpointId(): Promise<string> {
  const existing = lastDesktopEndpoint();
  if (existing !== null) return existing;
  const { invoke } = await import("@tauri-apps/api/core");
  const fresh = await invoke<string>("push_stream_endpoint_new");
  localStorage.setItem(ENDPOINT_KEY, fresh);
  return fresh;
}

let listenersInstalled: Promise<void> | null = null;

/** Listens for Rust's events. Runs once per page load. */
function installStreamListeners(): Promise<void> {
  if (listenersInstalled !== null) return listenersInstalled;
  const installer = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    await listen(TOKEN_REQUEST_EVENT, async () => {
      try {
        const token = await appserverServiceToken(STREAM_TOKEN_LXM);
        await invoke("push_stream_provide_token", { token });
      } catch (e) {
        console.warn("[push:desktop] could not provide a stream token:", e);
      }
    });

    // 400 is usually `NotRegistered`: the server dropped this endpoint.
    await listen<number>(REJECTED_EVENT, async (event) => {
      const endpoint = lastDesktopEndpoint();
      if (event.payload !== 400 || endpoint === null) {
        console.warn("[push:desktop] the appserver refused the stream:", event.payload);
        return;
      }
      if (Date.now() - lastRecoveryAt < RECOVERY_INTERVAL_MS) return;
      lastRecoveryAt = Date.now();
      try {
        await registerEndpoint(endpoint);
        await startStream(endpoint);
      } catch (e) {
        console.warn("[push:desktop] could not recover the stream:", e);
      }
    });

    // Rust sends the push payload as a JSON string when a notification is clicked.
    await listen<string>(NOTIFICATION_CLICKED_EVENT, (event) => {
      try {
        const route = routeFromEvent(JSON.parse(event.payload));
        if (route !== null) void goto(routeHref(route));
      } catch (e) {
        console.warn("[push:desktop] unreadable click payload:", e);
      }
    });
  };
  listenersInstalled = installer()
  return listenersInstalled
}

async function registerEndpoint(endpoint: string): Promise<void> {
  await px().procedure("space.roomy.push.registerSubscription", {
    endpoint,
    kind: "sse",
  });
}

async function startStream(endpoint: string): Promise<void> {
  const serverUrl = getAppserverOrigin();
  if (serverUrl === null) throw new Error("The appserver origin is not known yet");
  await installStreamListeners();
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("push_stream_start", { serverUrl, endpoint });
}

/** Registers this install and starts the stream. */
export async function ensureDesktopSubscription(): Promise<NativePushOutcome> {
  if (!desktopPushSupported()) return { status: "unsupported" };
  try {
    const endpoint = await endpointId();
    await registerEndpoint(endpoint);
    await startStream(endpoint);
    return { status: "ok" };
  } catch (e) {
    console.error("[push:desktop] enable failed:", e);
    return { status: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Restarts the stream at login if notifications were enabled before. */
export async function resumeDesktopStream(): Promise<void> {
  const endpoint = lastDesktopEndpoint();
  if (endpoint === null) return;
  try {
    await registerEndpoint(endpoint);
    await startStream(endpoint);
  } catch (e) {
    console.warn("[push:desktop] could not resume the stream:", e);
  }
}

/** Stops the stream and unregisters */
export async function clearDesktopSubscription(): Promise<NativePushOutcome> {
  if (!desktopPushSupported()) return { status: "unsupported" };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("push_stream_stop");
  } catch (e) {
    console.warn("[push:desktop] could not stop the stream:", e);
  }
  const endpoint = lastDesktopEndpoint();
  if (endpoint === null) return { status: "ok" };
  try {
    await px().procedure("space.roomy.push.unregisterSubscription", { endpoint });
    localStorage.removeItem(ENDPOINT_KEY);
    return { status: "ok" };
  } catch (e) {
    console.warn("[push:desktop] unregister failed:", e);
    return { status: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}

export async function reportActiveRoom(room: string | null): Promise<void> {
  if (!desktopPushSupported()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("push_stream_set_active_room", { room });
  } catch (e) {
    console.warn("[push:desktop] could not report the active room:", e);
  }
}
