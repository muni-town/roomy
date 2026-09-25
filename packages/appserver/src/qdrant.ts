/**
 * Qdrant message-search service configuration.
 *
 * Qdrant is the global message-search index. The appserver indexes every
 * message as a sparse BM25 vector in the `messages` collection and serves
 * `space.roomy.search.messages` from it — see `src/search/`.
 *
 * This module is the process-wide config singleton — set once during
 * `createAppserver`, then read by the indexer and the search handler that
 * don't receive it via constructor injection. Mirrors the
 * `src/happyview.ts` config-singleton pattern.
 *
 * When Qdrant is not configured (no `QDRANT_URL`), the appserver runs fine
 * without it: the indexer queues nothing and the search endpoint returns
 * 503. Enabling Qdrant later picks up every message via the boot backfill
 * sweep (see `src/search/indexer.ts`).
 */

/**
 * Configuration for connecting to a Qdrant search service.
 *
 * Env vars:
 * - `QDRANT_URL` — base HTTP origin (required to enable Qdrant)
 * - `QDRANT_API_KEY` — API key for authenticated deployments
 */
export interface QdrantConfig {
  /** Base HTTP origin (no trailing slash), e.g. `https://search-staging.roomy.space`. */
  url: string;
  /**
   * Explicit port for the client. The Qdrant client appends `:6333`
   * whenever the URL has no explicit port — even for https — so a
   * Cloudflare-fronted Qdrant (443 only) must pass `port: 443` explicitly.
   */
  port?: number;
  /** API key for authenticated deployments. */
  apiKey?: string;
}

/**
 * Parse Qdrant configuration from environment variables.
 *
 * Reads `QDRANT_URL` and `QDRANT_API_KEY`. Returns `null` when `QDRANT_URL`
 * is unset OR not a valid http(s) URL — callers fall back to no-op behaviour
 * (no indexing, no search). An invalid URL is treated as disabled rather
 * than crashing the request path: the Qdrant client constructor throws on a
 * protocol-less URL, and a misconfigured env must not 500 every search.
 *
 * Port: the Qdrant client defaults to `:6333` when the URL has no explicit
 * port, even for https. Cloudflare-fronted Qdrant (like
 * search-staging.roomy.space) only listens on 443, so a bare https URL is
 * normalized to `port: 443` (passed to the client constructor — URL string
 * munging can't express it, `new URL()` drops default ports).
 */
export function getQdrantConfig(): QdrantConfig | null {
  const url = process.env.QDRANT_URL;
  if (!url) return null;
  const trimmed = url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    console.warn(
      `[qdrant] QDRANT_URL is not a valid http(s) URL (${JSON.stringify(url)}) — message search disabled; expected e.g. https://search-staging.roomy.space`,
    );
    return null;
  }
  const parsed = new URL(trimmed);
  const port = parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : undefined;
  const apiKey = process.env.QDRANT_API_KEY;
  return {
    url: trimmed,
    ...(port !== undefined ? { port } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

// ─── Process-wide singleton ───────────────────────────────────────────────

let instance: QdrantConfig | null | undefined;

/**
 * Initialize the Qdrant config singleton from env vars.
 * Called once during `createAppserver`.
 */
export function initQdrant(): QdrantConfig | null {
  instance = getQdrantConfig();
  return instance;
}

/**
 * Explicitly set the Qdrant config (tests).
 */
export function setQdrant(config: QdrantConfig | null): void {
  instance = config;
}

/**
 * Get the process-wide Qdrant config, or `null` if not configured.
 * Returns `null` if `initQdrant` hasn't been called yet.
 */
export function getQdrant(): QdrantConfig | null {
  if (instance === undefined) return null;
  return instance;
}
