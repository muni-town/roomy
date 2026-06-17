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
 */
export async function fetchEmbedData(
  url: string,
  signal?: AbortSignal,
): Promise<Embed | null> {
  const locale =
    typeof navigator !== "undefined"
      ? navigator.languages?.[0] || navigator.language || "en"
      : "en";

  try {
    const res = await fetch(`${EMBED_SERVICE_URL}?lang=${locale}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: url,
      signal,
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
    if (err instanceof DOMException && err.name === "AbortError") {
      return null;
    }
    console.warn(`[embed] fetch failed for ${url}:`, err);
    return null;
  }
}

// ─── Database helpers ────────────────────────────────────────────────────

/**
 * Find all `comp_embed_link` entries that don't yet have corresponding
 * `comp_embed_link_data` rows. These are links that need enrichment.
 */
export function findPendingLinks(db: Database, limit = 50): string[] {
  const rows = db
    .query<{ entity: string }, []>(
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
 * Best-effort — failures are logged and silently ignored.
 */
export async function enrichLink(
  db: Database,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const embed = await fetchEmbedData(url, signal);
    storeEmbedData(db, url, embed);
  } catch (err) {
    console.warn(`[embed] enrichment failed for ${url}:`, err);
  }
}

/**
 * Enrich all pending links in the database.
 * Processes up to `limit` links per call, best-effort.
 * Returns the list of URLs that were successfully enriched.
 */
export async function enrichPendingLinks(
  db: Database,
  limit = 10,
  signal?: AbortSignal,
): Promise<string[]> {
  const pending = findPendingLinks(db, limit);
  if (pending.length === 0) return [];

  const enriched: string[] = [];
  for (const url of pending) {
    if (signal?.aborted) break;
    await enrichLink(db, url, signal);
    enriched.push(url);
  }
  return enriched;
}

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
