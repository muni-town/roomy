/**
 * The one dynamic-import seam for `livekit-client`.
 *
 * `livekit-client` is a large media SDK, and most sessions never open a call:
 * a space with no voice rooms never touches it. A static import would put it
 * in the app shell's initial graph, so it is reached only through these two
 * functions, which the bundler turns into separate chunks. (The dynamic import
 * here is deliberate, not incidental — see the note on each function.)
 *
 * The indirection also gives the unit tests one thing to replace: mocking this
 * module replaces the whole media layer without a real SFU, which is what
 * `VoiceCallState`'s tests do.
 */

import type * as LiveKit from "livekit-client";

/** The LiveKit module surface `VoiceCallState` uses. */
export type LiveKitModule = typeof LiveKit;

/**
 * Load `livekit-client` (code-split; first call fetches the chunk).
 *
 * The specifier is a literal, so a static import would work — it is dynamic
 * only to keep the SDK out of the initial bundle for sessions that never join
 * a call.
 */
export function loadLiveKit(): Promise<LiveKitModule> {
  return import("livekit-client");
}

/**
 * The E2EE worker, as a module worker.
 *
 * Vite's `?worker` suffix turns the import into a worker constructor; the
 * e2ee-worker entry is exported by `livekit-client` for exactly this. Dynamic
 * for the same bundle-size reason as {@link loadLiveKit}, and because the
 * `?worker` transformation is a Vite-only specifier the type checker does not
 * see until the build resolves it.
 */
export async function createE2EEWorker(): Promise<Worker> {
  const { default: E2EEWorker } = await import("livekit-client/e2ee-worker?worker");
  return new E2EEWorker();
}
