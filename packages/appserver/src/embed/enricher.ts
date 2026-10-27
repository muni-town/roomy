/**
 * Embed enricher: detects URLs in message content, enriches them with link
 * metadata via the in-appserver OG + oEmbed pipeline, and caches results in the
 * global `link_embeds` store (see `./store.ts`).
 *
 * A URL can owe two independent pieces of work — an OpenGraph fetch and a tile
 * resolution (`./tiles.ts`) — and both land in the same stored embed payload.
 * They succeed, fail and retry separately: a URL whose origin refuses scrapers
 * still renders its tile, and a tile that will not resolve never costs the
 * OpenGraph card. The pair is composed here, once, so the store holds one row
 * per URL rather than one per source.
 *
 * Enrichment is best-effort and non-blocking — failures are settled (or
 * scheduled for retry) but never crash the materialization pipeline.
 */

import type { DbLike } from "../db/types.ts";
import type { Embed } from "./types.ts";
import { probeLinkMetadata } from "./metadata.ts";
import {
  selectAttempts,
  selectLinkEmbedState,
  settleLinkEmbeds,
  writeSettledLinkEmbed,
  writeTransientLinkEmbed,
} from "./store.ts";
import {
  TILE_RESOLVER_VERSION,
  recogniseTileUrl,
  resolveTileForUrl,
  tileResolutionEnabled,
  type TileResolution,
} from "./tiles.ts";
import { canonicalUrl } from "../queries/links.ts";

/**
 * In-flight dedup: maps a URL to the enrichment promise currently fetching
 * it. Concurrent `enrichLinkAcrossSpaces(url)` calls share a single network
 * request and a single DB write. The entry is cleared once the promise
 * settles.
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
 * Of the given URLs, return those that still owe enrichment — held by a
 * `comp_embed_link` row in `spaceDb` and either never attempted, or recognised
 * as a tile URL whose tile is missing or was resolved by an older resolver.
 * Returned URLs are the store's keys, so a caller that pokes the sweeper with
 * them cannot fetch one the read paths would miss.
 *
 * Two queries rather than one join: which links a message contains is
 * log-derived and stays per-space, while the enriched metadata is a function of
 * an outbound fetch and lives in the global DB — separate files, so no single
 * statement can span them. The per-space side narrows the candidates; the store
 * lookup then drops the ones with nothing left to do.
 *
 * "Nothing left to do" is not the same as "has a row": a URL enriched before
 * tiles existed has an OpenGraph row and a tile it has never resolved, which is
 * exactly the retroactive case — every historical post link in a space becomes
 * a tile on its next read, with no rewrite and no backfill pass.
 *
 * The two sides are keyed differently: a link attachment's entity id carries
 * Roomy's `?message=<id>` encoding, while the store is keyed by the canonical
 * URL. The per-space query matches the entity id it is given; the store query
 * and the result use {@link canonicalUrl}.
 */
export async function filterPendingUrls(
  spaceDb: DbLike,
  globalDb: DbLike,
  urls: string[],
): Promise<string[]> {
  if (urls.length === 0) return [];
  const placeholders = urls.map(() => "?").join(",");
  const rows = await spaceDb
    .query(
      `select entity from comp_embed_link where entity in (${placeholders})`,
    )
    .all<{ entity: string }>([...urls]);
  if (rows.length === 0) return [];
  const held = [...new Set(rows.map((r) => canonicalUrl(r.entity)))];
  const state = await selectLinkEmbedState(globalDb, held);
  // With resolution switched off a row is the whole story again: the store's
  // original rule, "never attempted".
  if (!tileResolutionEnabled()) return held.filter((url) => !state.has(url));
  return held.filter((url) => {
    const known = state.get(url);
    if (!known) return true;
    return (
      recogniseTileUrl(url) !== null &&
      known.tileVersion < TILE_RESOLVER_VERSION
    );
  });
}

/**
 * Queue the tile half of the URLs a read has just served.
 *
 * Demand-driven rather than a backfill: a message that links a Bluesky post
 * resolves its tile on the next sweep after someone reads it, so an old
 * message needs no rewrite, no migration and no deploy-time pass over the log.
 * The row is `insert or ignore`d into the same global `pending_links` index the
 * write path uses, so a page of 50 messages linking one post asks once and the
 * sweeper's existing retry schedule bounds the work.
 *
 * Only URLs a tile mapping claims and whose row has no tile at the current
 * resolver version are queued; everything else is a no-op, which is what makes
 * this safe to call on every read. Returns the URLs queued, for the caller to
 * poke the sweeper with.
 */
export async function enqueueStaleTiles(
  globalDb: DbLike,
  entries: ReadonlyArray<{ url: string; spaceDid: string; messageId: string }>,
): Promise<string[]> {
  if (!tileResolutionEnabled()) return [];
  const candidates = entries.filter(
    (e) => recogniseTileUrl(canonicalUrl(e.url)) !== null,
  );
  if (candidates.length === 0) return [];

  const state = await selectLinkEmbedState(
    globalDb,
    candidates.map((e) => canonicalUrl(e.url)),
  );
  const queued = new Set<string>();
  for (const entry of candidates) {
    const url = canonicalUrl(entry.url);
    const known = state.get(url);
    if (known && known.tileVersion >= TILE_RESOLVER_VERSION) continue;
    await globalDb.run(
      `insert or ignore into pending_links (space_did, message_id, url, created_at)
       values (?, ?, ?, ?)`,
      [entry.spaceDid, entry.messageId, url, Date.now()],
    );
    queued.add(url);
  }
  return [...queued];
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
 * The parts of a row a caller composes itself, when more than the OpenGraph
 * fetch contributed to it.
 */
export interface EmbedComposition {
  /**
   * The payload to store. Defaults to the fetched embed on success and to null
   * otherwise — what a caller that only ever fetched OpenGraph data means.
   */
  embedJson?: string | null;
  /**
   * The tile resolver version to stamp, or 0 for a row with no tile work.
   * A version below `TILE_RESOLVER_VERSION` reopens the row's tile half.
   */
  tileVersion?: number;
}

/**
 * Persist the outcome of an embed fetch, including retry scheduling for
 * transient failures.
 *
 * - `ok` / `definitive`: write the embed (or null) and clear retry state —
 *   the URL is settled and leaves the pending set.
 * - `transient`: write the composed embed, bump `attempts`, and set
 *   `retry_after` to now + exponential backoff so the sweeper re-queues it
 *   later rather than abandoning it (or hammering the service immediately).
 *
 * A transient failure that reaches {@link maxTransientAttempts} is the
 * exception to the last rule: the URL is settled here exactly like a
 * definitive failure (retry state cleared) so it leaves the pending set, and
 * `true` is returned so the caller can report it as an abandoned host rather
 * than a no-data page. Retrying such a URL again is what a permanently-dead
 * host would otherwise do forever.
 *
 * The attempt count is shared by both halves of a row: a tile that will not
 * resolve spends the same budget as an origin that will not answer, because
 * from the row's point of view both are "this URL is not finishing".
 *
 * Uses UPSERT (`on conflict do update`) so `created_at` is preserved across
 * re-fetches. The transient path reads the existing attempt count first
 * (safe: the enrichment dedups per URL so there is no concurrent writer).
 *
 * Returns whether the row was settled by the attempt ceiling.
 */
export async function storeEmbedData(
  db: DbLike,
  url: string,
  result: FetchResult,
  composition: EmbedComposition = {},
): Promise<boolean> {
  const embedJson =
    composition.embedJson !== undefined
      ? composition.embedJson
      : result.status === "ok"
        ? JSON.stringify(result.embed)
        : null;
  const tileVersion = composition.tileVersion ?? 0;

  if (result.status === "transient") {
    const attempts = (await selectAttempts(db, url)) + 1;
    if (attempts >= maxTransientAttempts()) {
      // The ceiling: settle it like a definitive failure. `attempts` is kept
      // (rather than reset) so the row records how many tries the host got.
      await writeSettledLinkEmbed(db, url, embedJson, attempts, tileVersion);
      return true;
    }
    await writeTransientLinkEmbed(
      db,
      url,
      embedJson,
      attempts,
      Date.now() + backoffMs(attempts),
      tileVersion,
    );
    return false;
  }
  // Success or definitive failure — settled, no retry.
  await writeSettledLinkEmbed(db, url, embedJson, 0, tileVersion);
  return false;
}

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
  await settleLinkEmbeds(db, entries);
}

/**
 * What one URL's enrichment produced.
 *
 * Two independent halves produce it, so the statuses say what the ROW is worth
 * as well as what happened:
 *
 *   - `ok`: the row is settled and has something to render.
 *   - `definitive`: settled, nothing to render (the origin has no metadata and
 *     no tile claims the URL, or the AppView says the record is gone).
 *   - `abandoned`: settled by the attempt ceiling — the host has used every
 *     retry the schedule allows.
 *   - `transient`: not settled, nothing new; the caller keeps the row pending
 *     and retries after a backoff.
 *   - `partial`: not settled, but new data was stored (one half resolved while
 *     the other is still owed a retry). The caller should announce the data and
 *     still keep the row pending.
 *   - `noop`: neither half owed anything — the row was already settled when it
 *     was selected. The caller drops the pending entry.
 */
export type EnrichOutcome =
  | { status: "ok"; embed: Embed }
  | { status: "partial"; embed: Embed }
  | { status: "definitive"; embed: null }
  | { status: "abandoned"; embed: null }
  | { status: "transient"; embed: null }
  | { status: "noop"; embed: null };

/** The stored payload of a row, or null when it has none or is unparseable. */
function parseStoredEmbed(embedJson: string | null): Embed | null {
  if (!embedJson) return null;
  try {
    const parsed = JSON.parse(embedJson) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Embed) : null;
  } catch {
    return null;
  }
}

/**
 * Whether a stored payload says anything a card can draw.
 *
 * A row can hold an envelope with neither OpenGraph fields nor a tile — the
 * shape left behind when a tile for a deleted record is retracted. Storing that
 * would render an empty card, so it is written as no data instead.
 */
function hasCardData(embed: Embed | null): boolean {
  if (!embed) return false;
  return Boolean(
    embed.tile ||
      embed.t ||
      embed.d ||
      embed.p ||
      embed.au ||
      embed.footer ||
      embed.imgs?.length ||
      embed.vid ||
      embed.thumb,
  );
}

/**
 * Enrich a single URL into the global store, where every space that shared it
 * reads the result.
 *
 * Resolves the two halves the row can owe — the OpenGraph fetch and, for a URL
 * a tile mapping claims, the tile — and writes what they produced as one
 * payload. Which halves are owed comes from the row itself: a settled row owes
 * only a stale tile, which is what makes resolution retroactive without
 * re-fetching every page a space has ever linked.
 *
 * A URL is pending in one `pending_links` row per (space, message), so the
 * sweeper selects the same URL several times in a batch; the in-flight dedup
 * means the fetches happen once and the single global write settles it for all
 * of them.
 *
 * A DB write failure (e.g. `storeEmbedData` throwing) is RE-THROWN so the
 * sweeper can detect a failing DB and back off.
 */
export async function enrichLinkAcrossSpaces(
  globalDb: DbLike,
  url: string,
  signal?: AbortSignal,
): Promise<EnrichOutcome> {
  const existing = inFlightLinks.get(url);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await resolveUrl(globalDb, url, signal);
    } finally {
      inFlightLinks.delete(url);
    }
  })();

  inFlightLinks.set(url, promise);
  return promise;
}

/** The body of one URL's enrichment. See {@link enrichLinkAcrossSpaces}. */
async function resolveUrl(
  db: DbLike,
  url: string,
  signal?: AbortSignal,
): Promise<EnrichOutcome> {
  // A URL is on the tile path when a mapping claims it AND the deployment has
  // switched resolution on. Off, this is the pre-tile pipeline exactly: the
  // OpenGraph half is always owed and no row is consulted.
  const onTilePath = recogniseTileUrl(url) !== null && tileResolutionEnabled();
  const state = onTilePath ? (await selectLinkEmbedState(db, [url])).get(url) : undefined;

  // The OpenGraph half is owed unless the row already holds its result: no row
  // at all (never attempted), a row with a retry window (an unpaid transient
  // failure), or a row that settled with no payload — a URL the page yielded
  // nothing for, which the pending index can still ask about again. A row that
  // settled WITH data owes only a stale tile.
  //
  // Off the tile path there is no row in hand, which lands on "owed": a URL
  // the sweeper selected owes its OpenGraph fetch, exactly as before tiles.
  const ogOwed =
    state === undefined || state.embedJson === null || state.retryAfter !== null;
  const tileOwed =
    onTilePath && (state?.tileVersion ?? 0) < TILE_RESOLVER_VERSION;
  if (!ogOwed && !tileOwed) return { status: "noop", embed: null };

  let embed = parseStoredEmbed(state?.embedJson ?? null);
  let tileVersion = state?.tileVersion ?? 0;

  const [og, tile] = await Promise.all([
    ogOwed ? fetchEmbedData(url, signal) : Promise.resolve(null),
    tileOwed ? resolveTileForUrl(url, signal) : Promise.resolve(null),
  ]);

  if (og?.status === "ok") {
    // The fetched payload replaces the stored OpenGraph fields; the tile is the
    // other half's and survives.
    embed = { ...og.embed, ...(embed?.tile ? { tile: embed.tile } : {}) } as Embed;
  }

  if (tile?.status === "ok") {
    embed = {
      ...(embed ?? { v: "1", ts: new Date().toISOString(), ty: "link" }),
      tile: tile.tile,
    } as Embed;
    tileVersion = TILE_RESOLVER_VERSION;
  } else if (tile?.status === "definitive") {
    // The record is gone: no attempt can bring it back, so the row is stamped
    // and any tile it still holds is retracted rather than left stale.
    tileVersion = TILE_RESOLVER_VERSION;
    if (embed?.tile) {
      const { tile: _dropped, ...rest } = embed;
      embed = rest as Embed;
    }
  }

  if (!hasCardData(embed)) embed = null;
  const embedJson = embed ? JSON.stringify(embed) : null;

  const ogSettled = og === null || og.status !== "transient";
  const tileSettled = tile === null || (tile as TileResolution).status !== "transient";
  const produced = og?.status === "ok" || tile?.status === "ok";

  if (!ogSettled || !tileSettled) {
    const settledByCeiling = await storeEmbedData(
      db,
      url,
      { status: "transient" },
      { embedJson, tileVersion },
    );
    if (!settledByCeiling) {
      return produced && embed
        ? { status: "partial", embed }
        : { status: "transient", embed: null };
    }
    // The ceiling settled the row: fall through to the settled answer, so the
    // data it holds is still announced.
    return embed
      ? { status: "ok", embed }
      : { status: "abandoned", embed: null };
  }

  await writeSettledLinkEmbed(db, url, embedJson, 0, tileVersion);
  return embed ? { status: "ok", embed } : { status: "definitive", embed: null };
}

// Bulk pending-link enrichment is owned by the centralized sweeper
// (see `embed/sweeper.ts`). There is intentionally no per-call
// `enrichPendingLinks` here — it was the root cause of the over-fetching bug
// (every SpaceMaterializer called it independently on every batch).

/**
 * Number of enrichments currently in flight (one shared fetch per URL via
 * {@link enrichLinkAcrossSpaces}'s dedup). Exposed for the `/health/embed`
 * endpoint so operators can see sweep pressure without scraping logs.
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
  at: number,
): Promise<string[]> {
  const urls = extractUrls(content);
  if (urls.length === 0) return [];

  const detected: string[] = [];
  for (const url of urls) {
    // Ensure the entity row exists (room = messageId so it's scoped to this message)
    await db.run(
      `insert or ignore into entities (id, stream_id, room, created_at, updated_at)
       values (?, '', ?, ?, ?)`,
      [url, messageId, at, at],
    );
    // Insert into comp_embed_link if not already present. Track newly-inserted
    // rows (changes > 0) so only genuinely-new links get prioritised.
    const res = await db.run(
      `insert or ignore into comp_embed_link (entity, show_preview, created_at, updated_at)
       values (?, 1, ?, ?)`,
      [url, at, at],
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
  at: number,
): Promise<string[]> {
  if (urls.length === 0) return [];

  const detected: string[] = [];
  for (const url of urls) {
    // Ensure the entity row exists (room = messageId so it's scoped to this message)
    await db.run(
      `insert or ignore into entities (id, stream_id, room, created_at, updated_at)
       values (?, '', ?, ?, ?)`,
      [url, messageId, at, at],
    );
    // Insert into comp_embed_link if not already present. Track newly-inserted
    // rows (changes > 0) so only genuinely-new links get prioritised.
    const res = await db.run(
      `insert or ignore into comp_embed_link (entity, show_preview, created_at, updated_at)
       values (?, 1, ?, ?)`,
      [url, at, at],
    );
    if (res.changes > 0) detected.push(url);
  }
  return detected;
}
