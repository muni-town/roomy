/**
 * LiveKit configuration.
 *
 * LiveKit is an external WebRTC SFU: the appserver never touches media, it
 * mints access tokens and consumes webhooks. When LiveKit is not configured
 * every voice path degrades instead of failing — `getToken` returns nulls, the
 * participant/active-call reads return empty, and the client renders no call
 * affordances. That is what lets voice ship before a deployment exists.
 *
 * Env vars:
 * - `LIVEKIT_URL` — the SFU's WebSocket origin, handed to clients in the
 *   token response (the appserver is the only component that knows it)
 * - `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — mint access tokens and derive
 *   the room name; the secret signs both the tokens and, by default, webhooks
 * - `LIVEKIT_WEBHOOK_SECRET` — webhook signing secret, when it differs from
 *   `LIVEKIT_API_SECRET` (Shared LiveKit clusters can have separate signing)
 * - `LIVEKIT_SERVER_ID` — first segment of the room-name scheme, so two
 *   deployments sharing one LiveKit project cannot see each other's rooms
 *
 * This module is also the process-wide singleton, mirroring `happyview.ts`:
 * set once during `createAppserver`, then read by handlers and background
 * loops that do not receive it via constructor injection.
 */

export interface LiveKitConfig {
  /** SFU origin as clients should reach it, e.g. `wss://livekit.example`. */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** Webhook HMAC secret. Defaults to `apiSecret`. */
  webhookSecret: string;
  /** First segment of the room name. Defaults to `"roomy"`. */
  serverId: string;
}

/** Access-token lifetime. Short by design: the client re-mints on reconnect. */
export const LIVEKIT_TOKEN_TTL_SECONDS = 300;

/**
 * Parse LiveKit configuration from environment variables.
 * Returns null when `LIVEKIT_URL`, `LIVEKIT_API_KEY`, or `LIVEKIT_API_SECRET`
 * is missing — callers then take their unconfigured path.
 */
export function getLiveKitConfig(): LiveKitConfig | null {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) return null;
  return {
    url: url.replace(/\/+$/, ""),
    apiKey,
    apiSecret,
    webhookSecret: process.env.LIVEKIT_WEBHOOK_SECRET || apiSecret,
    serverId: process.env.LIVEKIT_SERVER_ID || "roomy",
  };
}

// ─── Process-wide singleton ───────────────────────────────────────────────

let instance: LiveKitConfig | null | undefined;

/** Initialize the config singleton from env. Called once by `createAppserver`. */
export function initLiveKit(): LiveKitConfig | null {
  instance = getLiveKitConfig();
  return instance;
}

/** Explicitly set the config (tests). */
export function setLiveKit(config: LiveKitConfig | null): void {
  instance = config;
}

/**
 * The process-wide LiveKit config, or null when it is unconfigured.
 * Mirrors `getHappyView`: one read point for handlers and background loops
 * that do not receive the config via constructor injection.
 */
export function getLiveKit(): LiveKitConfig | null {
  return instance ?? null;
}
