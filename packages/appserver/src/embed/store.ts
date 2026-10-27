/**
 * The global `link_embeds` store: enriched link metadata, keyed by URL.
 *
 * The value is a function of an outbound HTTP response, not of the event log,
 * and the URL is the whole key — nothing about it is space-scoped. Keeping it
 * in the per-space DB is what made a space rebuilt from the log (or derived by
 * a second worker) render bare links until its own sweeper re-fetched them, so
 * the store lives in the global DB and both the enricher and the read paths go
 * through this module.
 *
 * The read paths do not join against it in SQL: the per-space DB and the global
 * DB are separate files, so a `join` cannot cross them. They collect the URLs
 * their page holds and hydrate from here in JS.
 */

import type { DbLike } from "../db/types.ts";

/**
 * Max URLs per statement. The read paths bind a page's URLs, and the sweeper
 * binds a whole settled chunk, so the list is bounded by the page size rather
 * than a constant — chunked to stay well inside SQLite's bind limit.
 */
const CHUNK = 500;

/** Chunks a list for a `in (...)` statement. */
function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(items.slice(i, i + CHUNK));
  }
  return out;
}

/**
 * The stored embed JSON for each of `urls` that has a row, keyed by URL. A URL
 * with no row is absent (never attempted); a row whose `embed_json` is null is
 * present with a null value (attempted, no data).
 */
export async function selectEmbedJsonByUrl(
  db: DbLike,
  urls: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unique = [...new Set(urls)];
  if (unique.length === 0) return out;

  for (const chunk of chunks(unique)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .query(
        `select url, embed_json from link_embeds where url in (${placeholders})`,
      )
      .all<{ url: string; embed_json: string | null }>([...chunk]);
    for (const row of rows) out.set(row.url, row.embed_json);
  }
  return out;
}

/** What the store knows about one URL: its embed payload and its tile stage. */
export interface LinkEmbedState {
  /** The stored embed JSON, or null when the URL has no data stored. */
  embedJson: string | null;
  /**
   * The resolver version that last finished a tile attempt for this URL; 0
   * when no attempt has completed. A reader compares it against
   * `TILE_RESOLVER_VERSION` to decide whether the tile is stale.
   */
  tileVersion: number;
  /**
   * The epoch-ms instant a transient failure becomes eligible for another
   * fetch, or null when the row is settled. A settled row is never re-fetched
   * for its OpenGraph half — only a stale tile reopens the work.
   */
  retryAfter: number | null;
}

/**
 * The embed payload and tile stage of each of `urls` that has a row.
 *
 * One read for both halves of a row's state: the payload is what a reader
 * renders and the tile version is what says whether more work is owed, and
 * they are only meaningful together.
 */
export async function selectLinkEmbedState(
  db: DbLike,
  urls: readonly string[],
): Promise<Map<string, LinkEmbedState>> {
  const out = new Map<string, LinkEmbedState>();
  const unique = [...new Set(urls)];
  if (unique.length === 0) return out;

  for (const chunk of chunks(unique)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .query(
        `select url, embed_json, tile_version, retry_after
           from link_embeds where url in (${placeholders})`,
      )
      .all<{
        url: string;
        embed_json: string | null;
        tile_version: number | null;
        retry_after: number | null;
      }>([...chunk]);
    for (const row of rows) {
      out.set(row.url, {
        embedJson: row.embed_json,
        tileVersion: row.tile_version ?? 0,
        retryAfter: row.retry_after,
      });
    }
  }
  return out;
}

/**
 * Write a settled row (an embed, or null for "the service had no data") with no
 * pending retry. UPSERT so `created_at` survives a re-fetch of the same URL.
 *
 * `tileVersion` is the resolver version that last finished a tile attempt, and
 * it is always written: the caller composes the embed payload and the tile
 * stage together, so a write that carried no tile still says which version
 * decided there was none.
 */
export async function writeSettledLinkEmbed(
  db: DbLike,
  url: string,
  embedJson: string | null,
  attempts: number,
  tileVersion: number,
): Promise<void> {
  await db.run(
    `insert into link_embeds
       (url, embed_json, attempts, retry_after, tile_version, fetched_at, updated_at)
     values (?, ?, ?, null, ?, (unixepoch() * 1000), (unixepoch() * 1000))
     on conflict(url) do update set
       embed_json = excluded.embed_json,
       attempts = excluded.attempts,
       retry_after = null,
       tile_version = excluded.tile_version,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at`,
    [url, embedJson, attempts, tileVersion],
  );
}

/**
 * Write a transient failure: the embed payload as it stands, an escalated
 * attempt count, and the epoch-ms instant the URL becomes eligible for another
 * fetch.
 *
 * The payload is written rather than nulled because a failure in one half must
 * not discard the other: a URL whose OpenGraph fetch failed may already carry
 * a resolved tile, and that tile is what the card renders meanwhile.
 */
export async function writeTransientLinkEmbed(
  db: DbLike,
  url: string,
  embedJson: string | null,
  attempts: number,
  retryAfter: number,
  tileVersion: number,
): Promise<void> {
  await db.run(
    `insert into link_embeds
       (url, embed_json, attempts, retry_after, tile_version, fetched_at, updated_at)
     values (?, ?, ?, ?, ?, (unixepoch() * 1000), (unixepoch() * 1000))
     on conflict(url) do update set
       embed_json = excluded.embed_json,
       attempts = excluded.attempts,
       retry_after = excluded.retry_after,
       tile_version = excluded.tile_version,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at`,
    [url, embedJson, attempts, retryAfter, tileVersion],
  );
}

/** The attempt count recorded for `url`, or 0 when it has no row. */
export async function selectAttempts(db: DbLike, url: string): Promise<number> {
  const row = await db
    .query("select attempts from link_embeds where url = ?")
    .get<{ attempts: number }>(url);
  return row?.attempts ?? 0;
}

/**
 * Settle URLs that have no retry left to spend, WITHOUT fetching them, in one
 * statement per chunk.
 *
 * Each written row is what the enricher's attempt-ceiling branch produces for
 * the same URL — `retry_after` cleared — so the read side (which keys off
 * `embed_json`) cannot tell which path settled it. `attempts` is written back
 * UNCHANGED rather than incremented: no attempt is being made.
 *
 * `embed_json` is left alone. A row reaching the ceiling failed its OpenGraph
 * fetch, but it may still carry a tile resolved earlier, and settling the one
 * must not throw away the other.
 */
export async function settleLinkEmbeds(
  db: DbLike,
  entries: ReadonlyArray<{ url: string; attempts: number }>,
): Promise<void> {
  if (entries.length === 0) return;
  for (const chunk of chunks(entries)) {
    const valuesPh = chunk
      .map(() => "(?, null, ?, null, 0, (unixepoch() * 1000), (unixepoch() * 1000))")
      .join(", ");
    const params = chunk.flatMap((e) => [e.url, e.attempts]);
    await db.run(
      `insert into link_embeds
         (url, embed_json, attempts, retry_after, tile_version, fetched_at, updated_at)
       values ${valuesPh}
       on conflict(url) do update set
         attempts = excluded.attempts,
         retry_after = null,
         fetched_at = excluded.fetched_at,
         updated_at = excluded.updated_at`,
      params,
    );
  }
}

/**
 * Every URL currently parked in an open transient-retry window, with the
 * attempt count the window was scheduled from.
 *
 * The windows live in the store rather than in memory so a restart resumes the
 * backoff instead of re-fetching the whole parked backlog at once.
 */
export async function selectParkedLinkEmbeds(
  db: DbLike,
  now: number,
): Promise<Array<{ url: string; attempts: number; retryAfter: number }>> {
  const rows = await db
    .query(
      `select url, attempts, retry_after
         from link_embeds
        where retry_after is not null and retry_after > ?`,
    )
    .all<{ url: string; attempts: number; retry_after: number }>([now]);
  return rows.map((r) => ({
    url: r.url,
    attempts: r.attempts,
    retryAfter: r.retry_after,
  }));
}
