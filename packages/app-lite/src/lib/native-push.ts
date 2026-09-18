/**
 * Native (Tauri) notification bridge.
 *
 * The webview (WKWebView on macOS/iOS) has no service worker, so the web-push
 * path (`push.svelte.ts`) reports "unsupported" inside the Tauri apps. This
 * module is the native equivalent: it uses `tauri-plugin-notification` to show
 * OS notifications directly from the live sync connection.
 *
 * Scope: notifications while the app is running (foreground). The WebSocket
 * dies when the app is backgrounded/suspended, so this is a dev-testing
 * convenience, not a replacement for APNs remote push (see the APNs plan).
 *
 * The plugin injects a `window.Notification` shim, so `sendNotification`
 * works in the webview. `isPermissionGranted`/`requestPermission` are the
 * plugin's own commands.
 */

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { RICHTEXT_MIME, blocksToPlaintext } from "@roomy-space/sdk";
import { parseRichTextContent } from "$lib/components/chat/enrich-internal-links";
import { renderMarkdownPlaintext } from "@roomy/design/utils";
/** True when the native notification plugin is available. */
export function nativePushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    typeof window.Notification !== "undefined"
  );
}

/** Request notification permission (user gesture required on macOS/iOS). */
export async function ensureNativePermission(): Promise<boolean> {
  if (!nativePushSupported()) return false;
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === "granted";
  }
  return granted;
}

/** Render a message body as plaintext for the notification body. */
function messageBody(content: string, mimeType?: string): string {
  if (mimeType === RICHTEXT_MIME) {
    const blocks = parseRichTextContent(content);
    return blocks ? blocksToPlaintext(blocks) : "";
  }
  return renderMarkdownPlaintext(content);
}

/**
 * Show a native notification for a new message. Best-effort: permission
 * failures and plugin errors are logged, never thrown to the sync loop.
 */
export async function showNativeMessageNotification(opts: {
  roomName?: string;
  authorName: string;
  content: string;
  mimeType?: string;
  spaceId: string;
  roomId: string;
}): Promise<void> {
  if (!nativePushSupported()) return;
  try {
    const granted = await ensureNativePermission();
    if (!granted) return;
    const body = messageBody(opts.content, opts.mimeType).slice(0, 200);
    sendNotification({
      title: opts.roomName ? `${opts.roomName} — ${opts.authorName}` : opts.authorName,
      body: body || "New message",
      // Click-through: the room route is /[space]/[room].
      extra: { spaceId: opts.spaceId, roomId: opts.roomId },
    });
  } catch (e) {
    console.warn("[native-push] notification failed:", e);
  }
}
