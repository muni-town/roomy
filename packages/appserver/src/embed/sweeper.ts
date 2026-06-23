/**
 * Centralized embed enrichment sweeper.
 *
 * A single process-wide background loop owns ALL pending link enrichment.
 * Per-space SpaceMaterializers never fetch embeds themselves — they only
 * call {@link pokeEmbedSweeper} when new links are detected, and this loop
 * drains the global `comp_embed_link` pending set.
 *
 * Why this exists
 * ---------------
 * The original implementation called `enrichPendingLinks` independently from
 * (a) every SpaceMaterializer on every live event batch, (b) once per space
 * at startup, and (c) once per space after backfill. Because every space
 * shares one process-wide DB, each call re-read the *same global* pending
 * list, and because there was no in-flight dedup and no fetch timeout, a
 * single URL was fetched — and errored — dozens-to-hundreds of times while
 * the embed service was slow or down.
 *
 * Centralizing fixes all three amplifiers at once:
 *   - Exactly one in-flight fetch per URL (dedup lives in `enricher.ts`).
 *   - Every fetch has a hard timeout (see `FETCH_TIMEOUT_MS`).
 *   - Sequential processing — never more than one outbound embed request in
 *     flight at a time, so the service can't be flooded.
 *   - A self-healing idle poll catches links detected during backfill or
 *     carried over from a previous session.
 */

import { Database } from "bun:sqlite";
import type { Ulid } from "@roomy-space/sdk";
import {
  enrichLink,
  findPendingLinks,
  filterPendingUrls,
  inFlightCount,
} from "./enricher.ts";
import type { Embed } from "./types.ts";
import { selectMessages } from "../queries/selectMessages.ts";
import { log } from "../log.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
  MessageDiffOp,
} from "../invalidation/types.ts";

// ─── Configuration ──────────────────────────────────────────────────────

/** Max pending links to pull from the DB per sweep batch. */
const SWEEP_BATCH = 25;
/** How often to poll for pending links while idle (no pokes). */
const IDLE_POLL_MS = 30_000;
/**
 * Max concurrent outbound embed-service fetches per sweep batch. Bounded so
 * a large pending batch can't flood the embed service, while still draining
 * far faster than strictly sequential (a batch of 25 finishes in
 * ~ceil(25/8) ≈ 4 fetch round-trips instead of 25). Tunable via env for ops.
 */
const CONCURRENCY = Number(process.env.EMBED_SWEEPER_CONCURRENCY ?? 8);

// ─── Singleton state ────────────────────────────────────────────────────

let sweeperDb: Database | undefined;
let sweeperRouter: InvalidationRouter | undefined;
let started = false;

// ─── Stats (for /health/embed) ─────────────────────────────────────────
// Lifetime counters incremented in the drain loop. Non-null enrichLink →
// success; null → a definitive or transient FetchResult (failure/settled).
// Reset by _resetEmbedSweeper (tests only). Exposed via embedSweeperStats().
let statsEnrichedOk = 0;
let statsEnrichedNull = 0;
/**
 * Resolved by {@link pokeEmbedSweeper} to wake an idle loop immediately.
 * Null when the loop is busy draining (so extra pokes are cheap no-ops).
 */
let wake: (() => void) | null = null;
/**
 * Consecutive DB errors seen by the sweeper. Used to escalate a backoff so a
 * dead/unreachable DB (e.g. macOS `SQLITE_IOERR_VNODE` under I/O pressure)
 * doesn't cause a tight fetch-then-fail loop that wastes embed-service calls
 * and spams logs. Reset to 0 on a successful DB cycle.
 */
let dbErrorCount = 0;
/** Timestamp (ms) until which the sweeper should skip fetching and just idle. */
let dbBackoffUntil = 0;
/**
 * Priority queue of freshly-detected live link URLs. Drained before the
 * oldest-first backlog so a newly posted link is enriched within seconds
 * instead of waiting behind thousands of historical (backfilled) pending
 * links. Populated by {@link pokeEmbedSweeper} from createMessage batches.
 */
const priorityLinks = new Set<string>();

// ─── Public API ─────────────────────────────────────────────────────────

export interface EmbedSweeperOpts {
  /** Process-wide materialisation DB. Pending links live here. */
  db: Database;
  /** Optional invalidation router — used to push re-fetch signals to clients. */
  invalidationRouter?: InvalidationRouter;
}

/**
 * Start the global embed sweeper. Idempotent — safe to call multiple times.
 * Called once at appserver startup (see `index.ts`).
 */
export function startEmbedSweeper(opts: EmbedSweeperOpts): void {
  if (started) return;
  started = true;
  sweeperDb = opts.db;
  sweeperRouter = opts.invalidationRouter;
  // Detached background loop — must never reject the process. Any throw is
  // logged and the loop continues (see inner try/catch per sweep).
  void runSweeperLoop().catch((err) => {
    log.error("[embed-sweeper] loop crashed:", err);
  });
}

/**
 * Snapshot of sweeper state for the `/health/embed` endpoint. Lets operators
 * watch the backlog drain and see sweep pressure / DB backoff without scraping
 * (potentially rate-limited) logs. `pending` is queried separately in the
 * health handler (it needs the DB) and merged in there.
 */
export function embedSweeperStats(): {
  priorityQueue: number;
  inFlight: number;
  enrichedOk: number;
  enrichedNull: number;
  dbErrorCount: number;
  dbBackoffActive: boolean;
} {
  return {
    priorityQueue: priorityLinks.size,
    inFlight: inFlightCount(),
    enrichedOk: statsEnrichedOk,
    enrichedNull: statsEnrichedNull,
    dbErrorCount,
    dbBackoffActive: Date.now() < dbBackoffUntil,
  };
}

/**
 * Wake the sweeper to drain pending links immediately. Cheap and safe to
 * call frequently: if a sweep is already in progress this is a no-op.
 *
 * Pass freshly-detected `urls` to prioritise them over the backfill backlog —
 * the loop drains the priority queue before the oldest-first pending set.
 * URLs already enriched are skipped by `filterPendingUrls` in the loop.
 */
export function pokeEmbedSweeper(urls?: string[]): void {
  if (urls && urls.length > 0) {
    for (const u of urls) priorityLinks.add(u);
  }
  if (wake) {
    const fn = wake;
    wake = null;
    fn();
  }
}

/**
 * Read-driven prioritisation: when a client reads messages (getMessages /
 * getMessage), jump any never-attempted links in those messages ahead of the
 * oldest-first backfill backlog, so the viewing user sees the cards promptly
 * instead of waiting hours behind erroring/timing-out backlog links. This is
 * the READ counterpart to the WRITE-driven poke in SpaceMaterializer — write
 * prioritisation only helps newly-posted links, not links in messages a user
 * is currently viewing (which were detected during backfill and sit in the
 * backlog).
 *
 * `filterPendingUrls` returns only links with no data row yet, so
 * already-enriched links are a no-op and transient-failed links keep their
 * backoff (we don't hammer a down service on every refetch). Cheap: a single
 * LEFT JOIN, skipped entirely when the page has no links.
 */
export function prioritiseLinksForRead(
  db: Database,
  messages: ReadonlyArray<
    Readonly<{ linkEmbeds: ReadonlyArray<{ url: string }> }>
  >,
): void {
  const linkUrls = messages.flatMap((m) => m.linkEmbeds.map((l) => l.url));
  if (linkUrls.length === 0) return;
  try {
    const pending = filterPendingUrls(db, linkUrls);
    if (pending.length > 0) pokeEmbedSweeper(pending);
  } catch (err) {
    // Embed prioritisation is best-effort: a transient DB error (e.g. a macOS
    // SQLITE_IOERR_VNODE from I/O pressure) must NEVER turn a successful
    // getMessages/getMessage into a 500. Messages are the product; embed cards
    // are a secondary enhancement. The sweeper's idle poll picks these links
    // up regardless, so skipping the poke on a DB hiccup is harmless.
    console.warn("[embed] prioritiseLinksForRead failed:", err);
  }
}

/**
 * Record a DB error and escalate a backoff so the loop pauses fetching rather
 * than fetch 8 links per cycle only to fail every write. Capped; reset by
 * {@link markDbOk} on a successful DB cycle.
 */
function markDbError(err: unknown): void {
  dbErrorCount = Math.min(dbErrorCount + 1, 8);
  const backoffMs = Math.min(60_000 * 2 ** (dbErrorCount - 1), 30 * 60_000);
  dbBackoffUntil = Date.now() + backoffMs;
  console.warn(
    `[embed-sweeper] DB error (#${dbErrorCount}); backing off ${Math.round(backoffMs / 1000)}s:`,
    err,
  );
}

/** Mark the DB as healthy again (a successful DB cycle resets the backoff). */
function markDbOk(): void {
  if (dbErrorCount !== 0) dbErrorCount = 0;
  if (dbBackoffUntil !== 0) dbBackoffUntil = 0;
}

// ─── Loop ───────────────────────────────────────────────────────────────

async function runSweeperLoop(): Promise<void> {
  const db = sweeperDb;
  if (!db) return;

  for (;;) {
    // If the DB has been erroring, wait out the backoff before touching it
    // again — don't fetch links only to fail every write (wastes embed-service
    // calls and spams logs). A poke can still wake us early, but we re-check
    // the backoff at the top of the next iteration.
    const now = Date.now();
    if (now < dbBackoffUntil) {
      await waitForWake(dbBackoffUntil - now);
      continue;
    }

    let pending: string[] = [];

    // 1. Priority: freshly-detected live links first, so a newly posted
    //    link is enriched within seconds instead of waiting behind the
    //    entire backfill backlog. filterPendingUrls skips any that are
    //    already enriched (e.g. a popular URL reposted) or no longer present.
    const priority = drainPriorityLinks(SWEEP_BATCH);
    if (priority.length > 0) {
      try {
        pending = filterPendingUrls(db, priority);
      } catch (err) {
        console.warn("[embed-sweeper] filterPendingUrls failed:", err);
        markDbError(err);
        pending = [];
      }
    }

    // 2. Backlog: fill the rest of the batch with the oldest pending links.
    if (pending.length < SWEEP_BATCH) {
      try {
        const backlog = findPendingLinks(db, SWEEP_BATCH - pending.length);
        // Dedupe in case a priority URL is also among the oldest pending
        // (rare — priority URLs are newest, backlog is oldest-first).
        pending = [...new Set([...pending, ...backlog])];
      } catch (err) {
        // A transient DB error shouldn't kill the loop. Back off so a
        // dead DB doesn't cause a tight fetch-and-fail cycle.
        console.warn("[embed-sweeper] findPendingLinks failed:", err);
        markDbError(err);
      }
    }

    if (pending.length > 0) {
      // Drain the batch with bounded concurrency so N links complete in
      // ~ceil(N/CONCURRENCY) fetch round-trips rather than N. Each
      // enrichLink is deduplicated (inFlightLinks) + timeout-bounded, and
      // resolves to the stored embed (null on failure).
      //
      // We stream invalidations per-URL as they SUCCEED (non-null embed): a
      // freshly-posted live link's card appears the moment ITS fetch
      // resolves — never waiting behind a slow/hung backlog URL in the same
      // batch (which can take up to FETCH_TIMEOUT_MS). Failed (null)
      // enrichments emit nothing: there is no new data to show, so we skip
      // the no-op diff and avoid spamming clients / the router while the
      // backfill backlog drains. Per-URL error isolation keeps one throwing
      // enrichLink from killing the whole loop.
      let cycleDbError: unknown = null;
      await mapWithConcurrency(pending, CONCURRENCY, async (url) => {
        let embed: Embed | null = null;
        try {
          embed = await enrichLink(db, url);
        } catch (err) {
          // enrichLink only throws for DB (storeEmbedData) errors — fetch
          // errors are handled inside fetchEmbedData (returns a
          // FetchResult). Capture once per cycle to drive backoff (don't
          // escalate per-link). Logged at debug: a failing DB under I/O
          // pressure can throw per-link per-cycle, which floods logs.
          if (cycleDbError === null) cycleDbError = err;
          log.debug(`[embed-sweeper] enrichLink threw for ${url}:`, err);
        }
        if (embed) {
          statsEnrichedOk++;
          emitEnrichmentInvalidation(db, [url]);
        } else {
          statsEnrichedNull++;
        }
      });
      if (cycleDbError !== null) markDbError(cycleDbError);
      else markDbOk(); // a successful write cycle → DB is healthy again
    }

    // A full batch means there may be more pending — loop without waiting.
    if (pending.length >= SWEEP_BATCH) continue;

    // Otherwise wait for a poke (new links) or the idle poll, whichever
    // comes first. This bounds latency for newly posted links while also
    // self-healing anything we missed (backfill, prior sessions).
    await waitForWake(IDLE_POLL_MS);
  }
}

/** Remove and return up to `limit` URLs from the priority queue. */
function drainPriorityLinks(limit: number): string[] {
  const out: string[] = [];
  for (const url of priorityLinks) {
    if (out.length >= limit) break;
    out.push(url);
    priorityLinks.delete(url);
  }
  return out;
}

/** Run `fn` over `items` with at most `limit` concurrent invocations. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]!);
      }
    },
  );
  await Promise.all(workers);
}

/** Resolve after `ms`, or immediately when {@link pokeEmbedSweeper} fires. */
function waitForWake(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// ─── Invalidation ───────────────────────────────────────────────────────

/**
 * After enrichment, stream the updated embed data to subscribed clients as
 * `#messageDiff` `update` ops — one frame per affected room. The client
 * patches its TanStack cache directly (no HTTP re-fetch) and the link card
 * appears the moment enrichment completes.
 *
 * `entities.room` on a link entity holds the message id that contained the
 * link (see `detectAndStoreLinks`). We resolve message → real room id via
 * the message entity's `room`, then re-select the full message snapshot
 * (which now carries the enriched `linkEmbeds` data) via `selectMessages`.
 *
 * The `update` op carries a complete `MessageDto` because the client
 * validates `#messageDiff` frames against the `Message` schema and drops
 * any frame missing a required field. Reactions are re-read from
 * `comp_reaction` (unchanged by enrichment); `myReactionId` is intentionally
 * omitted (broadcast diffs can't be per-user) — the client derives
 * "did I react?" from `reaction.dids`, so this doesn't affect rendering.
 */
function emitEnrichmentInvalidation(
  db: Database,
  enrichedUrls: string[],
): void {
  if (!sweeperRouter || enrichedUrls.length === 0) return;

  const placeholders = enrichedUrls.map(() => "?").join(",");
  let rows: { messageId: string; roomId: string }[] = [];
  try {
    // Two-hop resolution: link entity → its `room` (message id) →
    // message entity → its `room` (the real room id).
    //
    // Media/link entities store `room = messageId` (see ensureEntity calls
    // in the SDK message materializer and detectAndStoreLinks), NOT the
    // room id. A single-hop lookup yields the message id and emits a diff
    // for room:<messageId> — which never matches any client subscription.
    rows = db
      .query<{ messageId: string; roomId: string }, string[]>(
        `select link.room as messageId, msg.room as roomId
           from entities link
           join entities msg on msg.id = link.room
          where link.id in (${placeholders})
            and msg.room is not null`,
      )
      .all(...enrichedUrls);
  } catch (err) {
    console.warn("[embed-sweeper] room lookup failed:", err);
    return;
  }

  if (rows.length === 0) return;

  // Map each message id → its real room id (a URL may appear in multiple
  // messages; a message may contain multiple enriched URLs).
  const messageIdToRoom = new Map<string, string>();
  for (const r of rows) messageIdToRoom.set(r.messageId, r.roomId);

  let messages: ReturnType<typeof selectMessages>["messages"] = [];
  try {
    messages = selectMessages(db, {
      kind: "ids",
      ids: [...messageIdToRoom.keys()],
    }).messages;
  } catch (err) {
    console.warn("[embed-sweeper] selectMessages failed:", err);
    return;
  }

  // Group update ops by room so each room gets a single #messageDiff frame.
  const opsByRoom = new Map<string, MessageDiffOp[]>();
  for (const m of messages) {
    const roomId = messageIdToRoom.get(m.id);
    if (!roomId) continue;
    let ops = opsByRoom.get(roomId);
    if (!ops) {
      ops = [];
      opsByRoom.set(roomId, ops);
    }
    ops.push({ op: "update", key: m.id as Ulid, message: m });
  }

  if (opsByRoom.size === 0) return;

  const signals: InvalidationEvent[] = [];
  for (const [roomId, ops] of opsByRoom) {
    signals.push({
      kind: "messageDiff",
      signal: { roomId: roomId as Ulid, seq: 0, ops },
    });
  }

  sweeperRouter.emit(signals);
}

// ─── Test helpers ───────────────────────────────────────────────────────

/**
 * Reset the sweeper singleton (does not cancel an already-running loop).
 * Tests only — clears state so a fresh `startEmbedSweeper` can be issued.
 */
export function _resetEmbedSweeper(): void {
  started = false;
  sweeperDb = undefined;
  sweeperRouter = undefined;
  wake = null;
  priorityLinks.clear();
  dbErrorCount = 0;
  dbBackoffUntil = 0;
  statsEnrichedOk = 0;
  statsEnrichedNull = 0;
}
