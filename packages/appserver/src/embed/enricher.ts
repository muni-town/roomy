/**
 * Embed enricher: detects URLs in message content, fetches embed metadata
 * from the external embed service, and caches results in `comp_embed_link_data`.
 *
 * The embed service (Lantern-chat embed-service) accepts a URL via POST and
 * returns OpenGraph/oEmbed metadata as a JSON array: `[timestamp, EmbedV1]`.
 *
 * Enrichment is best-effort and non-blocking — failures are logged but never
 * crash the materialization pipeline.
 */

import { Database } from "bun:sqlite";
import type { Embed, EmbedServiceResponse } from "./types.ts";

// ─── Configuration ──────────────────────────────────────────────────────

const EMBED_SERVICE_URL =
  process.env.EMBED_SERVICE_URL ?? "https://embed.internal.weird.one";

/**
 * Hard timeout for a single embed-service request. The original
 * implementation threaded `signal` through but no caller ever constructed
 * one, so a slow or hung embed service left every link "pending" for the
 * full default-fetch window — long enough for every SpaceMaterializer to
 * re-fetch it on every batch. Tunable via env for ops.
 */
const FETCH_TIMEOUT_MS = Number(process.env.EMBED_FETCH_TIMEOUT_MS ?? 10_000);

/**
 * In-flight dedup: maps a URL to the enrichment promise currently fetching
 * it. Concurrent `enrichLink(url)` calls share a single network request and
 * a single DB write. The entry is cleared once the promise settles.
 *
 * This is the core fix for the over-fetching bug: previously each
 * SpaceMaterializer independently re-fetched the same global pending list
 * on every event batch, so one URL produced many concurrent fetches.
 */
const inFlightLinks = new Map<string, Promise<void>>();

// ─── URL detection ───────────────────────────────────────────────────────

/**
 * Regex to detect URLs in message content.
 *
 * Matches common URL patterns including protocol-relative and wrapped in
 * angle brackets (e.g. `<https://example.com>`). Skips trailing punctuation
 * that's not part of the URL.
 */
const URL_REGEX =
  /<?(https?:\/\/)[a-z0-9][-a-z0-9]*\.[a-z]{2,}[^\s<>]*[a-zA-Z0-9\/]>?/gi;

/**
 * Extract unique, valid HTTP(S) URLs from a string of text.
 * Strips surrounding angle brackets and trailing punctuation.
 */
export function extractUrls(text: string): string[] {
  const matches = text.matchAll(URL_REGEX);
  const urls = new Set<string>();

  for (const match of matches) {
    let url = match[0];
    // Strip surrounding angle brackets
    if (url.startsWith("<") && url.endsWith(">")) {
      url = url.slice(1, -1);
    }
    // Normalize: ensure protocol
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    urls.add(url);
  }

  return [...urls];
}

// ─── Embed service client ───────────────────────────────────────────────

/**
 * Fetch embed data for a single URL from the embed service.
 * Returns null if the service has no data or if the request fails.
 *
 * Always enforces a `FETCH_TIMEOUT_MS` hard timeout, combined with any
 * caller-provided `signal`. Without this, a hung embed service keeps the
 * URL "pending" indefinitely and amplifies re-fetches.
 */
export async function fetchEmbedData(
  url: string,
  signal?: AbortSignal,
): Promise<Embed | null> {
  const locale =
    typeof navigator !== "undefined"
      ? navigator.languages?.[0] || navigator.language || "en"
      : "en";

  // Timeout-scoped controller. We abort on either our own timeout or the
  // caller's signal (whichever fires first).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const res = await fetch(`${EMBED_SERVICE_URL}?lang=${locale}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: url,
      signal: controller.signal,
    });

    if (!res.ok) {
      if (res.status !== 404) {
        console.warn(
          `[embed] ${res.status} fetching data for ${url}: ${res.statusText}`,
        );
      }
      return null;
    }

    const data = (await res.json()) as EmbedServiceResponse;
    return data[1];
  } catch (err) {
    // Timeouts and caller aborts are expected when the service is slow/down;
    // treat them as "no data" rather than spamming warnings.
    if (isAbortError(err)) return null;
    console.warn(`[embed] fetch failed for ${url}:`, err);
    return null;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** True for any AbortError (DOMException in browsers, native Error in Bun/Node). */
function isAbortError(err: unknown): boolean {
  if (err && typeof err === "object" && "name" in err) {
    return (err as { name: unknown }).name === "AbortError";
  }
  return false;
}

// ─── Database helpers ────────────────────────────────────────────────────

/**
 * Find all `comp_embed_link` entries that don't yet have corresponding
 * `comp_embed_link_data` rows. These are links that need enrichment.
 */
export function findPendingLinks(db: Database, limit = 50): string[] {
  const rows = db
    .query<{ entity: string }, [number]>(
      `select el.entity
       from comp_embed_link el
       left join comp_embed_link_data eld on eld.entity = el.entity
       where eld.entity is null
       order by el.created_at asc
       limit ?`,
    )
    .all(limit);
  return rows.map((r) => r.entity);
}

/**
 * Store enriched embed data for a link URL.
 * Uses INSERT OR REPLACE so re-fetches update the cached data.
 */
export function storeEmbedData(
  db: Database,
  url: string,
  embed: Embed | null,
): void {
  db.run(
    `insert or replace into comp_embed_link_data (entity, embed_json, fetched_at, updated_at)
     values (?, ?, (unixepoch() * 1000), (unixepoch() * 1000))`,
    [url, embed ? JSON.stringify(embed) : null],
  );
}

/**
 * Enrich a single URL: fetch embed data and store in the database.
 *
 * Deduplicated via `inFlightLinks` — concurrent calls for the same URL
 * share one fetch + one write. Best-effort: failures are logged and
 * swallowed (a null row is still written so the URL leaves the pending
 * set rather than being retried on every sweep).
 */
export async function enrichLink(
  db: Database,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  const existing = inFlightLinks.get(url);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const embed = await fetchEmbedData(url, signal);
      storeEmbedData(db, url, embed);
    } catch (err) {
      console.warn(`[embed] enrichment failed for ${url}:`, err);
    } finally {
      inFlightLinks.delete(url);
    }
  })();

  inFlightLinks.set(url, promise);
  return promise;
}

// Bulk pending-link enrichment is owned by the centralized sweeper
// (see `embed/sweeper.ts`). There is intentionally no per-call
// `enrichPendingLinks` here — it was the root cause of the over-fetching bug
// (every SpaceMaterializer called it independently on every batch).
/**
 * Scan message content for URLs and insert any new ones into `comp_embed_link`.
 * Called during materialization (inside the transaction) so link detection is
 * atomic with the message insert.
 *
 * Skips URLs that already exist in `comp_embed_link` (via explicit LinkAttachment
 * or a previous scan of an edited message).
 */
export function detectAndStoreLinks(
  db: Database,
  messageId: string,
  content: string,
): void {
  const urls = extractUrls(content);
  if (urls.length === 0) return;

  for (const url of urls) {
    // Ensure the entity row exists (room = messageId so it's scoped to this message)
    db.run(
      `insert or ignore into entities (id, stream_id, room, created_at)
       values (?, '', ?, (unixepoch() * 1000))`,
      [url, messageId],
    );
    // Insert into comp_embed_link if not already present
    db.run(
      `insert or ignore into comp_embed_link (entity, show_preview, created_at, updated_at)
       values (?, 1, (unixepoch() * 1000), (unixepoch() * 1000))`,
      [url],
    );
  }
}
