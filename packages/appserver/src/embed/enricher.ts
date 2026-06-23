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
const inFlightLinks = new Map<string, Promise<Embed | null>>();

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
 * Outcome of an embed-service request for a single URL.
 * - `ok`: the service returned embed metadata.
 * - `definitive`: the URL has no embed data (404/410, or 200 with an empty
 *   payload) — not worth retrying.
 * - `transient`: the request failed in a way that may succeed later
 *   (timeout, 5xx, network error) — the caller should schedule a retry.
 */
export type FetchResult =
  | { status: "ok"; embed: Embed }
  | { status: "definitive" }
  | { status: "transient" };

/**
 * Fetch embed data for a single URL from the embed service.
 *
 * Always enforces a `FETCH_TIMEOUT_MS` hard timeout, combined with any
 * caller-provided `signal`. Without this, a hung embed service keeps the
 * URL "pending" indefinitely and amplifies re-fetches.
 *
 * Returns a {@link FetchResult} so the caller can distinguish a definitive
 * "no data" outcome (404 / empty) from a transient failure (timeout / 5xx /
 * network) — only the latter should be retried with backoff.
 */
export async function fetchEmbedData(
  url: string,
  signal?: AbortSignal,
): Promise<FetchResult> {
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

    // 404/410: the URL genuinely has no embed data — don't retry.
    if (res.status === 404 || res.status === 410)
      return { status: "definitive" };

    // Other non-OK (5xx, 429, …): the service erred transiently — retry later.
    if (!res.ok) {
      console.warn(
        `[embed] ${res.status} fetching data for ${url}: ${res.statusText}`,
      );
      return { status: "transient" };
    }

    const data = (await res.json()) as EmbedServiceResponse;
    const embed = data[1] as Embed | null;
    // 200 with an empty/null payload: the service has no data for this URL.
    if (!embed) return { status: "definitive" };
    return { status: "ok", embed };
  } catch (err) {
    // Timeouts and network errors are transient — retry later.
    if (isAbortError(err)) return { status: "transient" };
    console.warn(`[embed] fetch failed for ${url}:`, err);
    return { status: "transient" };
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
 * Of the given URLs, return those that are still pending enrichment —
 * present in `comp_embed_link` but with no `comp_embed_link_data` row yet.
 * Used by the sweeper to prioritise freshly-detected links without
 * re-fetching ones that are already enriched (e.g. a popular URL reposted).
 */
export function filterPendingUrls(db: Database, urls: string[]): string[] {
  if (urls.length === 0) return [];
  const placeholders = urls.map(() => "?").join(",");
  const rows = db
    .query<{ entity: string }, string[]>(
      `select el.entity
         from comp_embed_link el
         left join comp_embed_link_data eld on eld.entity = el.entity
        where eld.entity is null
          and el.entity in (${placeholders})`,
    )
    .all(...urls);
  return rows.map((r) => r.entity);
}

/**
 * Find all `comp_embed_link` entries that still need enrichment: either
 * never attempted (no `comp_embed_link_data` row) or a transient failure
 * whose backoff has elapsed (`retry_after` set and in the past). Definitive
 * failures (404) and successes have a data row with no `retry_after` and
 * are excluded. Ordered oldest-first by link creation so backfill drains
 * before newer transient-failure retries.
 */
export function findPendingLinks(db: Database, limit = 50): string[] {
  const now = Date.now();
  const rows = db
    .query<{ entity: string }, [number, number]>(
      `select el.entity
       from comp_embed_link el
       left join comp_embed_link_data eld on eld.entity = el.entity
       where eld.entity is null
          or (eld.retry_after is not null and eld.retry_after <= ?)
       order by el.created_at asc
       limit ?`,
    )
    .all(now, limit);
  return rows.map((r) => r.entity);
}

/**
 * Exponential backoff (ms) before retrying a transient failure, so a
 * persistently-dead URL is re-tried less and less often instead of every
 * sweep. Schedule: 1m, 5m, 30m, 2h, then capped at 6h. Tunable via env.
 */
function backoffMs(attempts: number): number {
  const schedule = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
  const cap = Number(process.env.EMBED_RETRY_CAP_MS ?? 6 * 60 * 60_000);
  return attempts <= schedule.length ? schedule[attempts - 1]! : cap;
}

/**
 * Persist the outcome of an embed fetch, including retry scheduling for
 * transient failures.
 *
 * - `ok` / `definitive`: write the embed (or null) and clear retry state —
 *   the URL is settled and leaves the pending set.
 * - `transient`: write a null embed, bump `attempts`, and set `retry_after`
 *   to now + exponential backoff so the sweeper re-queues it later rather
 *   than abandoning it (or hammering the service immediately).
 *
 * Uses UPSERT (`on conflict do update`) so `created_at` is preserved across
 * re-fetches. The transient path reads the existing attempt count first
 * (safe: `enrichLink` dedups per-URL so there is no concurrent writer).
 */
export function storeEmbedData(
  db: Database,
  url: string,
  result: FetchResult,
): void {
  if (result.status === "transient") {
    const row = db
      .query<{ attempts: number }, [string]>(
        `select attempts from comp_embed_link_data where entity = ?`,
      )
      .get(url);
    const attempts = (row?.attempts ?? 0) + 1;
    db.run(
      `insert into comp_embed_link_data
         (entity, embed_json, attempts, retry_after, fetched_at, updated_at)
       values (?, null, ?, ?, (unixepoch() * 1000), (unixepoch() * 1000))
       on conflict(entity) do update set
         embed_json = null,
         attempts = excluded.attempts,
         retry_after = excluded.retry_after,
         fetched_at = excluded.fetched_at,
         updated_at = excluded.updated_at`,
      [url, attempts, Date.now() + backoffMs(attempts)],
    );
    return;
  }
  // Success or definitive failure — settled, no retry.
  db.run(
    `insert into comp_embed_link_data
       (entity, embed_json, attempts, retry_after, fetched_at, updated_at)
     values (?, ?, 0, null, (unixepoch() * 1000), (unixepoch() * 1000))
     on conflict(entity) do update set
       embed_json = excluded.embed_json,
       attempts = 0,
       retry_after = null,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at`,
    [url, result.status === "ok" ? JSON.stringify(result.embed) : null],
  );
}

/**
 * Enrich a single URL: fetch embed data and store in the database.
 *
 * Deduplicated via `inFlightLinks` — concurrent calls for the same URL
 * share one fetch + one write. Best-effort: failures are logged and
 * swallowed. Transient failures (timeout / 5xx / network) schedule a retry
 * with exponential backoff via `retry_after`; definitive failures (404 /
 * no-data) and successes are settled (no retry).
 *
 * Returns the embed that was stored — non-null on success, `null` on
 * failure (transient or definitive). Callers can use the return to decide
 * whether to push an invalidation: only successes carry new data worth
 * streaming to clients, so skipping failed (null) results avoids spamming
 * no-op diffs while the backfill backlog drains.
 */
export async function enrichLink(
  db: Database,
  url: string,
  signal?: AbortSignal,
): Promise<Embed | null> {
  const existing = inFlightLinks.get(url);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await fetchEmbedData(url, signal);
      storeEmbedData(db, url, result);
      return result.status === "ok" ? result.embed : null;
    } catch (err) {
      console.warn(`[embed] enrichment failed for ${url}:`, err);
      return null;
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
 *
 * Returns the URLs that were newly inserted into `comp_embed_link` so the
 * caller can prioritise them for enrichment — a freshly posted link should
 * jump the backfill backlog rather than wait behind thousands of historical
 * pending links. URLs that already had a `comp_embed_link` row (already
 * pending or already enriched) are omitted from the return.
 */
export function detectAndStoreLinks(
  db: Database,
  messageId: string,
  content: string,
): string[] {
  const urls = extractUrls(content);
  if (urls.length === 0) return [];

  const detected: string[] = [];
  for (const url of urls) {
    // Ensure the entity row exists (room = messageId so it's scoped to this message)
    db.run(
      `insert or ignore into entities (id, stream_id, room, created_at)
       values (?, '', ?, (unixepoch() * 1000))`,
      [url, messageId],
    );
    // Insert into comp_embed_link if not already present. Track newly-inserted
    // rows (changes > 0) so only genuinely-new links get prioritised.
    const res = db
      .prepare(
        `insert or ignore into comp_embed_link (entity, show_preview, created_at, updated_at)
         values (?, 1, (unixepoch() * 1000), (unixepoch() * 1000))`,
      )
      .run(url);
    if (res.changes > 0) detected.push(url);
  }
  return detected;
}
