/**
 * HappyView profile index service configuration.
 *
 * HappyView is a lexicon-driven ATProto AppView written in Rust. It subscribes
 * to the Jetstream firehose, indexes records by collection, and serves XRPC
 * query endpoints — configurable with Lua scripts for custom logic.
 *
 * See https://happyview.dev for full documentation.
 *
 * The appserver uses HappyView as the first source in the profile fetch
 * pipeline:
 *
 *   1. HappyView (batched, fast, network-indexed)
 *   2. Bluesky appview fallback for DIDs HappyView doesn't have
 *
 * When HappyView is not configured (no endpoint), the appserver skips it and
 * falls back to the Bluesky appview directly — the original fast path.
 *
 * HappyView requires an API client key on every XRPC request (see
 * https://happyview.dev/getting-started/authentication). For server-to-server
 * callers like the appserver, a client secret is also recommended.
 *
 * This module is also the process-wide singleton — set once during
 * `createAppserver`, then read by handlers and materialization code that
 * don't receive it via constructor injection (e.g. `getProfileHandler` which
 * opens the DB directly). Mirrors the `openDb`/`getDb` singleton pattern.
 */

import { log } from "./log.ts";

/**
 * Configuration for connecting to a HappyView profile index service.
 *
 * Env vars:
 * - `HAPPYVIEW_ENDPOINT` — base HTTP origin (required to enable HappyView)
 * - `HAPPYVIEW_CLIENT_KEY` — API client key (`hvc_…`, required by HappyView)
 * - `HAPPYVIEW_CLIENT_SECRET` — API client secret (`hvs_…`, for server-to-server)
 */
export interface HappyViewConfig {
  /** Base HTTP origin (no trailing slash), e.g. `https://happyview.roomy.chat`. */
  endpoint: string;
  /** API client key (`hvc_…`). Required — HappyView rejects requests without it. */
  clientKey: string;
  /** API client secret (`hvs_…`). For server-to-server authentication. */
  clientSecret?: string;
}

/**
 * Parse HappyView configuration from environment variables.
 *
 * Reads `HAPPYVIEW_ENDPOINT`, `HAPPYVIEW_CLIENT_KEY`, and
 * `HAPPYVIEW_CLIENT_SECRET`. Returns `null` when `HAPPYVIEW_ENDPOINT` is
 * unset or `HAPPYVIEW_CLIENT_KEY` is missing — callers fall back to
 * Bluesky-only profile fetching.
 */
export function getHappyViewConfig(): HappyViewConfig | null {
  const endpoint = process.env.HAPPYVIEW_ENDPOINT;
  const clientKey = process.env.HAPPYVIEW_CLIENT_KEY;
  if (!endpoint || !clientKey) return null;
  const clientSecret = process.env.HAPPYVIEW_CLIENT_SECRET;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    clientKey,
    clientSecret,
  };
}

/**
 * Headers for a HappyView XRPC request.
 *
 * HappyView requires the client key on every request; the secret is optional
 * and only used for server-to-server callers. One helper so the batch and
 * single-DID paths cannot disagree about what they send.
 */
export function happyViewHeaders(
  config: HappyViewConfig,
): Record<string, string> {
  const headers: Record<string, string> = { "X-Client-Key": config.clientKey };
  if (config.clientSecret) headers["X-Client-Secret"] = config.clientSecret;
  return headers;
}


/**
 * Emit the one startup line that says whether the HappyView profile pipeline
 * is on. Without it, a deployment where HappyView is disabled is
 * indistinguishable from one where every request is rejected.
 */
export function logHappyViewStartup(config: HappyViewConfig | null): void {
  if (!config) {
    log.info("[happyview] profile pipeline disabled");
    return;
  }
  let host = "(invalid endpoint)";
  try {
    host = new URL(config.endpoint).host;
  } catch {
    // A malformed endpoint is still configuration worth reporting.
  }
  log.info(`[happyview] profile pipeline enabled (endpoint host: ${host})`);
}

// ─── Process-wide singleton ───────────────────────────────────────────────

let instance: HappyViewConfig | null | undefined;

/**
 * Initialize the HappyView config singleton from env vars.
 * Called once during `createAppserver`.
 */
export function initHappyView(): HappyViewConfig | null {
  instance = getHappyViewConfig();
  return instance;
}

/**
 * Explicitly set the HappyView config (tests).
 */
export function setHappyView(config: HappyViewConfig | null): void {
  instance = config;
}

/**
 * Get the process-wide HappyView config, or `null` if not configured.
 * Returns `null` if `initHappyView` hasn't been called yet.
 */
export function getHappyView(): HappyViewConfig | null {
  if (instance === undefined) return null;
  return instance;
}