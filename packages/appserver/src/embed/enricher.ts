/**
 * Embed enricher: detects URLs in message content, enriches them with link
 * metadata via the in-appserver OG + oEmbed pipeline, and caches results in
 * `comp_embed_link_data`.
 *
 * Enrichment is best-effort and non-blocking — failures are settled (or
 * scheduled for retry) but never crash the materialization pipeline.
 */

import type { DbLike } from "../db/types.ts";
import type { Embed } from "./types.ts";
import { openSpaceDb } from "../db/db.ts";
import { probeLinkMetadata } from "./metadata.ts";

/**
 * In-flight dedup: maps a URL to the enrichment promise currently fetching
 * it. Concurrent `enrichLink(url)` calls share a single network request and
 * a single DB write. The entry is cleared once the promise settles.
 *
 * Without this, each SpaceMaterializer independently re-fetches the same
 * global pending list on every event batch, so one URL produces many
 * concurrent fetches.
 */
const inFlightLinks = new Map<string, Promise<EnrichOutcome>>();

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
 * - `definitive`: the URL has no embed data, or the service deterministically
 *   refused it (400/401/403/404/410, or 200 with an empty payload) — not
 *   worth retrying. Client-error statuses are stable: bsky.app will always
 *   400 a scraper, eprint.iacr.org will always 403. Retrying them forever
 *   leaves a permanent backlog and a permanent log flood.
 * - `transient`: the request failed in a way that may succeed later
 *   (timeout, 5xx, 429, network error) — the caller should schedule a retry.
 */
export type FetchResult =
  | { status: "ok"; embed: Embed }
  | { status: "definitive" }
  | { status: "transient" };

/**
 * Fetch embed data for a single URL using the in-appserver OG + oEmbed
 * pipeline (`probeLinkMetadata`). Enrichment runs in-process, so posted
 * messages render the same link metadata the composer previews.
 *
 * Returns a {@link FetchResult} so the caller can distinguish a definitive
 * "no data" outcome (page loaded but no OG/oEmbed, or a stable 4xx) from a
 * transient failure (timeout / 5xx / 429 / network) — only the latter should
 * be retried with backoff.
 */
export async function fetchEmbedData(
  url: string,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const result = await probeLinkMetadata(url, signal);
  switch (result.status) {
    case "ok":
      // Wrap the LinkEmbedMetadata subset in the EmbedV1 envelope so the
      // existing storage/read path (Embed + selectMessages) is unchanged.
      return {
        status: "ok",
        embed: {
          v: "1",
          ts: new Date().toISOString(),
          ty: "link",
          ...result.metadata,
        } as Embed,
      };
    case "no-data":
      return { status: "definitive" };
    case "transient":
      return { status: "transient" };
  }
}

// ─── Database helpers ────────────────────────────────────────────────────

/**
 * Of the given URLs, return those that are still pending enrichment —
 * present in `comp_embed_link` but with no `comp_embed_link_data` row yet.
 * Used by the sweeper to prioritise freshly-detected links without
 * re-fetching ones that are already enriched (e.g. a popular URL reposted).
 */
export async function filterPendingUrls(db: DbLike, urls: string[]): Promise<string[]> {
  if (urls.length === 0) return [];
  const placeholders = urls.map(() => "?").join(",");
  const rows = await db
    .query(
      `select el.entity
         from comp_embed_link el
         left join comp_embed_link_data eld on eld.entity = el.entity
        where eld.entity is null
          and el.entity in (${placeholders})`,
    )
    .all<{ entity: string }>([...urls]);
  return rows.map((r) => r.entity);
}

/**
 * A pending embed link, as recorded in the global `pending_links` index.
 * Carries the owning space DID and the message id that contained the URL so
 * the sweeper can route enrichment + invalidation to the correct per-space
 * DB and delete the row once processed.
 */
export interface PendingLink {
  url: string;
  spaceDid: string;
  messageId: string;
}

/**
 * Read the global `pending_links` index: the pending embed links
 * awaiting enrichment across ALL per-space DBs. Ordered oldest-first by
 * `created_at` so backfill drains before newer links. Returns the pending
 * rows (URL + owning space + message) so the sweeper can group by space and
 * route enrichment/invalidation to the correct per-space DB.
 */
export async function findPendingLinks(
  db: DbLike,
  limit = 50,
  skipUrls?: ReadonlySet<string>,
): Promise<PendingLink[]> {
  // Exclude URLs currently in transient-retry backoff so the sweeper doesn't
  // keep pulling the same oldest down links and stall behind them. Without
  // this, a backlog whose oldest entries are all failing transiently would be
  // re-selected every cycle, filtered out, and never advance to newer links.
  const skip = skipUrls && skipUrls.size > 0 ? [...skipUrls] : [];
  const skipPh = skip.map(() => "?").join(",");
  const where = skip.length > 0 ? `where url not in (${skipPh})` : "";
  const rows = await db
    .query(
      `select space_did, message_id, url
       from pending_links
       ${where}
       order by created_at asc
       limit ?`,
    )
    .all<{ space_did: string; message_id: string; url: string }>([
      ...skip,
      limit,
    ]);
  return rows.map((r) => ({
    url: r.url,
    spaceDid: r.space_did,
    messageId: r.message_id,
  }));
}

/**
 * Read the global `pending_links` index for a specific set of URLs, returning
 * only those still pending. Used by the sweeper's priority path to resolve
 * which spaces a freshly-poked URL is pending in (a URL can appear in
 * multiple spaces).
 */
export async function findPendingLinksForUrls(
  db: DbLike,
  urls: string[],
): Promise<PendingLink[]> {
  if (urls.length === 0) return [];
  const placeholders = urls.map(() => "?").join(",");
  const rows = await db
    .query(
      `select space_did, message_id, url
       from pending_links
       where url in (${placeholders})
       order by created_at asc`,
    )
    .all<{ space_did: string; message_id: string; url: string }>([...urls]);
  return rows.map((r) => ({
    url: r.url,
    spaceDid: r.space_did,
    messageId: r.message_id,
  }));
}

/**
 * Exponential backoff (ms) before retrying a transient failure, so a
 * persistently-dead URL is re-tried less and less often instead of every
 * sweep. Schedule: 1m, 5m, 30m, 2h, then capped at 6h. Tunable via env.
 *
 * The schedule has no terminal step — it is only ever consulted for attempts
 * below {@link maxTransientAttempts}, which settles the URL instead of
 * retrying it. So the cap applies to at most the one retry before the ceiling.
 */
export function backoffMs(attempts: number): number {
  const schedule = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
  const cap = Number(process.env.EMBED_RETRY_CAP_MS ?? 6 * 60 * 60_000);
  return attempts <= schedule.length ? schedule[attempts - 1]! : cap;
}

/** Consecutive transient failures after which a URL is settled as abandoned. */
const MAX_TRANSIENT_ATTEMPTS_DEFAULT = 6;

/**
 * Consecutive transient failures a URL is allowed before it is settled as
 * {@link EnrichOutcome} `"abandoned"` and leaves the pending backlog.
 *
 * Without a ceiling, a host that is permanently gone but answers with a
 * timeout or a 5xx can never classify as `definitive`, so backoff parks it at
 * the 6h cap and re-fetches it forever: production held ~7.6k such URLs,
 * generating ~250 transient fetches an hour against hosts that had already
 * failed hundreds of times, while the backlog never drained.
 *
 * The value is set from the retry schedule's own shape. Retrying a URL that is
 * merely SLOW — not dead — has to survive a transient outage, and the
 * escalating schedule is what makes that affordable: a URL is re-tried at 1m,
 * 5m, 30m, 2h and 6h before the sixth consecutive failure, i.e. after ~8.6h of
 * continuously failing. A six-sample run of failures spread over that window is
 * a host that is not coming back, while a genuinely recovering host is still
 * caught by one of the five earlier retries. Tunable via env (minimum 1).
 */
export function maxTransientAttempts(): number {
  const n = Number(process.env.EMBED_MAX_ATTEMPTS ?? MAX_TRANSIENT_ATTEMPTS_DEFAULT);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : MAX_TRANSIENT_ATTEMPTS_DEFAULT;
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
 * A transient failure that reaches {@link maxTransientAttempts} is the
 * exception to the last rule: the URL is settled here exactly like a
 * definitive failure (null embed, retry state cleared) so it leaves the
 * pending set, and `true` is returned so the caller can report it as an
 * abandoned host rather than a no-data page. Retrying such a URL again is
 * what a permanently-dead host would otherwise do forever.
 *
 * Uses UPSERT (`on conflict do update`) so `created_at` is preserved across
 * re-fetches. The transient path reads the existing attempt count first
 * (safe: `enrichLink` dedups per-URL so there is no concurrent writer).
 *
 * Returns whether the row was settled by the attempt ceiling.
 */
export async function storeEmbedData(
  db: DbLike,
  url: string,
  result: FetchResult,
): Promise<boolean> {
  if (result.status === "transient") {
    const row = await db
      .query(
        `select attempts from comp_embed_link_data where entity = ?`,
      )
      .get<{ attempts: number }>([url]);
    const attempts = (row?.attempts ?? 0) + 1;
    if (attempts >= maxTransientAttempts()) {
      // The ceiling: settle it like a definitive failure. `attempts` is kept
      // (rather than reset) so the row records how many tries the host got.
      await writeSettled(db, url, null, attempts);
      return true;
    }
    await db.run(
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
    return false;
  }
  // Success or definitive failure — settled, no retry.
  await writeSettled(
    db,
    url,
    result.status === "ok" ? JSON.stringify(result.embed) : null,
    0,
  );
  return false;
}

/** Write a settled row (embed or null) with no pending retry. */
async function writeSettled(
  db: DbLike,
  url: string,
  embedJson: string | null,
  attempts: number,
): Promise<void> {
  await db.run(
    `insert into comp_embed_link_data
       (entity, embed_json, attempts, retry_after, fetched_at, updated_at)
     values (?, ?, ?, null, (unixepoch() * 1000), (unixepoch() * 1000))
     on conflict(entity) do update set
       embed_json = excluded.embed_json,
       attempts = excluded.attempts,
       retry_after = null,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at`,
    [url, embedJson, attempts],
  );
}

/** Max URLs per settle statement — stays well inside SQLite's bind limit. */
const SETTLE_CHUNK = 200;

/**
 * Settle URLs that are already at or past {@link maxTransientAttempts}, WITHOUT
 * fetching them.
 *
 * Such a URL has no retry left to spend: the next attempt would take the
 * `storeEmbedData` ceiling branch and settle the row anyway. Fetching it first
 * buys nothing and costs an outbound request to a host already measured as
 * gone, so the sweeper settles the row directly from the recorded retry state
 * and drops it from `pending_links`.
 *
 * Each written row is what the ceiling branch of {@link storeEmbedData}
 * produces for the same URL — null embed, `retry_after` cleared — so an
 * operator cannot tell from the DB whether a dead row was settled by a fetch
 * or by this path, and the read side (which keys off `embed_json`) is
 * unaffected. `attempts` is written back UNCHANGED rather than incremented:
 * no attempt is being made.
 *
 * Batched one statement per chunk of URLs, because the set this drains is
 * thousands of rows on first run and a per-URL round-trip would hold the sweep
 * cycle for seconds.
 *
 * The caller must not have these URLs in flight: {@link inFlightLinks} dedups
 * fetches, and settling a URL mid-fetch would race the result write. The
 * ceiling is what makes that safe here — a fetch that is genuinely in flight
 * cannot belong to a URL already at or past it, because the attempt that
 * reached the ceiling settled the row in the same breath. The sweeper is the
 * sole caller, and it runs this before selecting its batch.
 */
export async function settleOverCeiling(
  db: DbLike,
  entries: ReadonlyArray<{ url: string; attempts: number }>,
): Promise<void> {
  for (let i = 0; i < entries.length; i += SETTLE_CHUNK) {
    const chunk = entries.slice(i, i + SETTLE_CHUNK);
    const valuesPh = chunk.map(() => "(?, null, ?, null, (unixepoch() * 1000), (unixepoch() * 1000))").join(", ");
    const params = chunk.flatMap((e) => [e.url, e.attempts]);
    await db.run(
      `insert into comp_embed_link_data
         (entity, embed_json, attempts, retry_after, fetched_at, updated_at)
       values ${valuesPh}
       on conflict(entity) do update set
         embed_json = excluded.embed_json,
         attempts = excluded.attempts,
         retry_after = null,
         fetched_at = excluded.fetched_at,
         updated_at = excluded.updated_at`,
      params,
    );
  }
}

/**
 * Enrich a single URL: fetch embed data and store in the database.
 *
 * Deduplicated via `inFlightLinks` — concurrent calls for the same URL
 * share one fetch + one write.
 *
 * Returns the embed that was stored — non-null on success, `null` on a
 * non-DB failure (the fetch returned a definitive/transient `FetchResult`;
 * fetch-layer network errors are handled inside `fetchEmbedData` and never
 * reach here). A DB write failure (e.g. `storeEmbedData` throwing
 * `SQLITE_IOERR_VNODE`) is RE-THROWN so the sweeper can detect a failing DB
 * and back off rather than fetch a batch of links only to fail every write.
 * The sweeper is the sole caller and catches this; any other caller must
 * catch too. Callers can use the non-null return to decide whether to push an
 * invalidation: only successes carry new data worth streaming to clients,
 * so skipping failed (null) results avoids spamming no-op diffs while the
 * backfill backlog drains.
 */
export async function enrichLink(
  db: DbLike,
  url: string,
  signal?: AbortSignal,
): Promise<EnrichOutcome> {
  const existing = inFlightLinks.get(url);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await fetchEmbedData(url, signal);
      const abandoned = await storeEmbedData(db, url, result);
      if (result.status === "ok") return { status: "ok" as const, embed: result.embed };
      // A transient failure that hit the attempt ceiling is settled for good;
      // report it as abandoned so the caller doesn't keep the link pending.
      if (abandoned) return { status: "abandoned" as const, embed: null };
      return { status: result.status, embed: null };
    } catch (err) {
      // fetchEmbedData handles its own network errors (returns a
      // FetchResult), so a throw here is a DB write failure (e.g.
      // SQLITE_IOERR_VNODE under I/O pressure). Rethrow so the sweeper can
      // back off a failing DB rather than hammer it. The `finally` clears the
      // in-flight entry so a later retry actually re-fetches.
      throw err;
    } finally {
      inFlightLinks.delete(url);
    }
  })();

  inFlightLinks.set(url, promise);
  return promise;
}

/**
 * Enrich a single URL and store the result to EVERY per-space DB where it is
 * pending (a URL can appear in multiple spaces). Fetches ONCE per URL (reusing
 * the {@link inFlightLinks} dedup pattern shared with {@link enrichLink}), then
 * calls {@link storeEmbedData} for each space's DB.
 *
 * Returns the fetch outcome — `{ status, embed }` where `status` is
 * `"ok"` (embed stored), `"definitive"` (settled: no data / stable 4xx — the
 * caller should drop the link from the pending set), `"transient"`
 * (timeout / 5xx / 429 / network — the caller should keep it pending and
 * retry later), or `"abandoned"` (transient failures hit the attempt ceiling,
 * so the link is settled for good and the caller should drop it too).
 * `embed` is non-null only on `"ok"`. A DB write failure (e.g.
 * `storeEmbedData` throwing) is RE-THROWN so the sweeper can detect a failing
 * DB and back off.
 */
export type EnrichOutcome =
  | { status: "ok"; embed: Embed }
  | { status: "definitive"; embed: null }
  | { status: "abandoned"; embed: null }
  | { status: "transient"; embed: null };

export async function enrichLinkAcrossSpaces(
  url: string,
  spaces: string[],
  signal?: AbortSignal,
): Promise<EnrichOutcome> {
  const existing = inFlightLinks.get(url);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await fetchEmbedData(url, signal);
      let abandoned = false;
      for (const spaceDid of spaces) {
        abandoned = (await storeEmbedData(openSpaceDb(spaceDid), url, result)) || abandoned;
      }
      if (result.status === "ok") return { status: "ok" as const, embed: result.embed };
      if (abandoned) return { status: "abandoned" as const, embed: null };
      return { status: result.status, embed: null };
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
 * Number of enrichments currently in flight (one shared fetch per URL via
 * {@link enrichLink}'s dedup). Exposed for the `/health/embed` endpoint so
 * operators can see sweep pressure without scraping logs.
 */
export function inFlightCount(): number {
  return inFlightLinks.size;
}

/**
 * Total rows in the global `pending_links` index still awaiting enrichment.
 * Mirrors {@link findPendingLinks} but unbounded, for the `/health/embed`
 * endpoint so operators can watch the backlog drain.
 *
 * Counts ROWS, not distinct URLs: the PK is (space_did, message_id, url), so
 * one URL pending in N messages is N rows. Never compare this with the
 * sweeper's URL-keyed backoff count by subtraction — see
 * {@link classifyPendingLinks}.
 */
export async function countPendingLinks(db: DbLike): Promise<number> {
  const row = await db
    .query(`select count(*) as n from pending_links`)
    .get<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Row-level breakdown of the global `pending_links` backlog against a URL
 * skip set — the same set {@link findPendingLinks} excludes. Measures how many
 * rows are actually selectable and how many are parked, so a stall report can
 * state a cause instead of assuming one.
 *
 * Units are the whole point: `pending` counts ROWS while the sweeper's
 * transient backoff is keyed by URL, so `pending - transientBackoff`
 * under-counts parked rows and over-reports selectable ones. A backlog whose
 * every URL is parked still shows a positive difference whenever a URL is
 * pending in more than one message — which is exactly how a fully-parked
 * backlog gets misread as "N selectable rows". Counting the rows the skip set
 * excludes cannot make that mistake.
 *
 * Both counts come from ONE query so they describe the same snapshot (two
 * separate `count(*)`s could straddle an insert).
 */
export async function classifyPendingLinks(
  db: DbLike,
  skipUrls: ReadonlySet<string>,
): Promise<{ total: number; selectable: number; parked: number }> {
  const skip = skipUrls.size > 0 ? [...skipUrls] : [];
  const skipPh = skip.map(() => "?").join(",");
  const selectableExpr =
    skip.length > 0
      ? `sum(case when url not in (${skipPh}) then 1 else 0 end)`
      : `count(*)`;
  const row = await db
    .query(
      `select count(*) as total, ${selectableExpr} as selectable from pending_links`,
    )
    .get<{ total: number; selectable: number | null }>([...skip]);
  const total = row?.total ?? 0;
  const selectable = row?.selectable ?? 0;
  return { total, selectable, parked: total - selectable };
}

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
export async function detectAndStoreLinks(
  db: DbLike,
  messageId: string,
  content: string,
): Promise<string[]> {
  const urls = extractUrls(content);
  if (urls.length === 0) return [];

  const detected: string[] = [];
  for (const url of urls) {
    // Ensure the entity row exists (room = messageId so it's scoped to this message)
    await db.run(
      `insert or ignore into entities (id, stream_id, room, created_at)
       values (?, '', ?, (unixepoch() * 1000))`,
      [url, messageId],
    );
    // Insert into comp_embed_link if not already present. Track newly-inserted
    // rows (changes > 0) so only genuinely-new links get prioritised.
    const res = await db.run(
      `insert or ignore into comp_embed_link (entity, show_preview, created_at, updated_at)
       values (?, 1, (unixepoch() * 1000), (unixepoch() * 1000))`,
      [url],
    );
    if (res.changes > 0) detected.push(url);
  }
  return detected;
}

/**
 * Insert pre-extracted URLs into `comp_embed_link` (same semantics as
 * {@link detectAndStoreLinks}, but for callers that already have the URL
 * list — e.g. rich-text bodies whose `#link` facet URIs are extracted via
 * the SDK's `extractFacetUrls` instead of regex-scanning a content string).
 *
 * Returns the URLs that were newly inserted into `comp_embed_link`.
 */
export async function detectAndStoreLinksFromUrls(
  db: DbLike,
  messageId: string,
  urls: string[],
): Promise<string[]> {
  if (urls.length === 0) return [];

  const detected: string[] = [];
  for (const url of urls) {
    // Ensure the entity row exists (room = messageId so it's scoped to this message)
    await db.run(
      `insert or ignore into entities (id, stream_id, room, created_at)
       values (?, '', ?, (unixepoch() * 1000))`,
      [url, messageId],
    );
    // Insert into comp_embed_link if not already present. Track newly-inserted
    // rows (changes > 0) so only genuinely-new links get prioritised.
    const res = await db.run(
      `insert or ignore into comp_embed_link (entity, show_preview, created_at, updated_at)
       values (?, 1, (unixepoch() * 1000), (unixepoch() * 1000))`,
      [url],
    );
    if (res.changes > 0) detected.push(url);
  }
  return detected;
}
