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
 * Every space shares one process-wide DB, so a per-space fetch path would
 * re-read the *same global* pending list for each space on every event batch
 * (and again at startup and after backfill), fetching and erroring the same
 * URL dozens-to-hundreds of times while the embed service is slow or down.
 * Centralizing avoids all three amplifiers at once:
 *   - Exactly one in-flight fetch per URL (dedup lives in `enricher.ts`).
 *   - Every fetch has a hard timeout (see `FETCH_TIMEOUT_MS`).
 *   - Bounded concurrency (see `CONCURRENCY`) — the service can't be flooded.
 *   - A self-healing idle poll catches links detected during backfill or
 *     carried over from a previous session.
 */

import type { DbLike } from "../db/types.ts";
import type { StreamDid, Ulid } from "@roomy-space/sdk";
import {
  enrichLinkAcrossSpaces,
  findPendingLinks,
  findPendingLinksForUrls,
  filterPendingUrls,
  inFlightCount,
  backoffMs,
  classifyPendingLinks,
  type EnrichOutcome,
  type PendingLink,
} from "./enricher.ts";
import { openSpaceDb } from "../db/db.ts";
import { selectMessages } from "../queries/selectMessages.ts";
import type { MessageDto } from "../queries/selectMessages.ts";
import { log } from "../log.ts";
import { metrics } from "../metrics.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
  MessageDiffOp,
  QueryNsid,
} from "../invalidation/types.ts";

// ─── Configuration ──────────────────────────────────────────────────────

/** Max pending links to pull from the DB per sweep batch. */
const SWEEP_BATCH = 25;
/** How often to poll for pending links while idle (no pokes). */
const IDLE_POLL_MS = 30_000;
/**
 * Age (ms) past which a non-empty, unselected backlog counts as STALLED
 * rather than merely waiting. A backlog whose oldest row is this old while
 * nothing is in flight and a cycle selected nothing means transient-retry
 * backoff is pinning the whole queue. Retry backoff runs to ~5 attempts per
 * pending link with a 6h cap, so a fully parked queue selects nothing for
 * hours at a time and never drains. Tunable via env.
 */
const STALL_AGE_MS = Number(process.env.EMBED_STALL_AGE_MS ?? 30 * 60_000);
/**
 * Max concurrent outbound embed-service fetches per sweep batch. Bounded so
 * a large pending batch can't flood the embed service, while still draining
 * far faster than strictly sequential (a batch of 25 finishes in
 * ~ceil(25/8) ≈ 4 fetch round-trips instead of 25). Tunable via env for ops.
 */
const CONCURRENCY = Number(process.env.EMBED_SWEEPER_CONCURRENCY ?? 8);
/**
 * Ceiling (ms) for the loop's idle poll while the backlog is STALLED (a cycle
 * that selected nothing out of a non-empty, stale backlog). See
 * {@link sweepIdleDelayMs}: without a bound, an escalating stall poll would
 * delay noticing an EXPIRED backoff window by the stall's age (hours), since
 * nothing else wakes the loop at window expiry. Tunable via env.
 */
const STALL_POLL_MAX_MS = Number(
  process.env.EMBED_STALL_POLL_MAX_MS ?? 5 * 60_000,
);

/**
 * Yield (ms) after a FULL sweep batch that produced NO `ok` outcome, before
 * the loop runs the next cycle (see {@link sweepYieldsAfter}). Without it, a
 * batch of links that all fail (or all settle as definitive no-data) is
 * followed by the next batch IMMEDIATELY — production measured ~360 null
 * enrichments/min with `enrichedOk` flat at 0 across 37 samples, i.e. the
 * sweeper spending the box's time and outbound fetches at whatever rate the
 * fetches themselves allow while resolving nothing.
 *
 * Bound = {@link IDLE_POLL_MS}, so a no-progress batch runs at most once per
 * idle-poll interval — the rate at which the sweeper's OWN self-healing poll
 * would have picked the backlog up anyway. Measured on this box against a
 * 20,000-link all-failing backlog: 20,000 fetches/min unbounded (the whole
 * backlog in 60s), 300/min at a 5s yield (still near production's 360/min
 * measured churn), and 50/min at this bound — a 400× reduction, with the
 * modal inter-fetch gap the yield itself. A definitive backlog still drains:
 * 25 rows SETTLE and are deleted per batch, and each batch lands after one
 * poll interval at most.
 *
 * `waitForWake` is used, not a bare sleep, so a freshly-poked link cuts the
 * wait short. Tunable via env.
 */
const NO_OK_YIELD_MS = Number(
  process.env.EMBED_SWEEP_NO_OK_YIELD_MS ?? IDLE_POLL_MS,
);

// ─── Singleton state ────────────────────────────────────────────────────

let sweeperGlobalDb: DbLike | undefined;
let sweeperRouter: InvalidationRouter | undefined;
let started = false;
/** Resolved when the background loop exits. Used by stopEmbedSweeper. */
let loopPromise: Promise<void> | undefined;

// ─── Stats (for /health/embed) ─────────────────────────────────────────
// Lifetime counters incremented in the drain loop. Non-null enrichLink →
// success; a null outcome is split by CLASS, because the two classes mean
// opposite things: `definitive` (page loaded with no OG/oEmbed, or a stable
// 4xx) SETTLES the row and removes it from the backlog, while `transient`
// (timeout / 5xx / 429 / network) leaves the row pending to be re-selected
// after a backoff window. Summed into one counter (the previous
// `enrichedNull`), a backlog churning through failing URLs is
// indistinguishable from one settling dead ones. Reset by _resetEmbedSweeper
// (tests only). Exposed via embedSweeperStats().
let statsEnrichedOk = 0;
let statsEnrichedDefinitive = 0;
let statsEnrichedTransient = 0;
/**
 * Sweep cycles that ran a selection (not the DB-backoff bail), and how many
 * of those the loop throttled — a FULL batch that produced no `ok`, so it
 * yielded instead of running the next batch back-to-back. Exported as
 * `roomy_embed_sweep_cycles_total` / `roomy_embed_sweep_throttled_total`, so
 * the cycle RATE is readable from Grafana without hand-sampling
 * `/health/embed`: a high `rate(roomy_embed_sweep_cycles_total[5m])` with
 * `roomy_embed_enriched_ok_total` flat IS the churn.
 */
let statsSweepCycles = 0;
let statsSweepThrottled = 0;
/**
 * #messageDiff frames the sweeper actually emitted to clients (enrichment
 * completed AND the enriched message was resolved to a real room). Lets
 * operators confirm the invalidation path is firing, separate from whether
 * enrichment itself succeeded.
 */
let statsEnrichmentDiffs = 0;

// Prometheus counters for the same events, incremented where they happen
// rather than scraped from a snapshot. Primed with a 0 series at module load
// so every family is present in a scrape from process start — otherwise a
// missing `roomy_embed_enriched_ok_total` would be indistinguishable from
// "enrichment has never once succeeded", which is the state this task is
// about.
const metricSweepCycles = metrics.counter(
  "roomy_embed_sweep_cycles_total",
  "Embed sweep cycles that ran a selection. rate() is the cycle rate; compare against roomy_embed_sweep_throttled_total.",
);
const metricSweepThrottled = metrics.counter(
  "roomy_embed_sweep_throttled_total",
  "Embed sweep cycles the loop yielded after: a FULL batch that produced no ok outcome (the anti-churn bound).",
);
const metricEnrichedOk = metrics.counter(
  "roomy_embed_enriched_ok_total",
  "Embed links enriched to a real embed — the success metric. Flat while cycles still run means churn.",
);
const metricEnrichedDefinitive = metrics.counter(
  "roomy_embed_enriched_definitive_total",
  "Embed links settled as definitive no-data (no OG/oEmbed, or a stable 4xx). These LEAVE the backlog.",
);
const metricEnrichedTransient = metrics.counter(
  "roomy_embed_enriched_transient_total",
  "Embed links that failed transiently (timeout / 5xx / 429 / network). These STAY pending and re-enter after a backoff window.",
);
for (const c of [
  metricSweepCycles,
  metricSweepThrottled,
  metricEnrichedOk,
  metricEnrichedDefinitive,
  metricEnrichedTransient,
]) {
  c.inc({}, 0);
}
/**
 * How many times {@link backlogStuck} has CHANGED VALUE since start (both
 * directions). Distinct from `backlogStuckSkipped` (how many cycles the stall
 * persisted through): the two together say whether one backlog is stalled, or
 * whether the gauge is flapping — a range query over samples cannot show
 * transitions.
 * Exposed on /health/embed and as `roomy_embed_backlog_stuck_transitions_total`.
 */
let statsBacklogStuckTransitions = 0;
// Prometheus mirror for the same event. Primed to 0 at module load so the
// family is present in a scrape from process start (see the counters below).
const metricBacklogStuckTransitions = metrics.counter(
  "roomy_embed_backlog_stuck_transitions_total",
  "Transitions of the embed backlog-stall flag, both directions. A high rate with flat roomy_embed_enriched_ok_total means the stall gauge is flapping.",
);
metricBacklogStuckTransitions.inc({}, 0);
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
 * Backlog-stall signal. Set on a cycle that selected nothing while the DB
 * backlog is non-empty and its oldest row is older than {@link STALL_AGE_MS}.
 * That is the "the backlog is not draining" state — invisible to
 * `pending`/`inFlight` (both read 0/false in-memory while 5k rows sit in
 * `pending_links`). `since` is when the stall began (ms); `skipped` counts the
 * cycles the stall persisted through — selection found nothing, or the work it
 * selected settled no rows. Exposed on /health/embed and as a Prometheus gauge
 * so an alert can fire on the stalled backlog.
 *
 * The CAUSE is deliberately not asserted here: {@link stallCause} and
 * {@link lastCycle} carry the measured numbers from the cycle that failed to
 * select, and the warn at the end of {@link sweepCycle} reports them. A fixed
 * cause string is false whenever the skip set does not cover every pending
 * ROW — the sweeper's backoff is keyed by URL while the backlog is rows.
 */
let backlogStuck = false;
let backlogStuckSince = 0;
let backlogStuckSkipped = 0;

/**
 * Why the last sweep cycle selected nothing, measured — not assumed — on the
 * cycle itself. `parked`/`selectable` are ROW counts from
 * {@link classifyPendingLinks} against the same URL skip set the backlog query
 * uses, so they cannot disagree with what was actually excluded.
 *
 * - `all-parked`: every pending row is inside a backoff window (`selectable`
 *   0), so returning empty is correct and the backlog will drain as windows
 *   expire.
 * - `selectable-but-absent`: rows were NOT parked yet the query still returned
 *   nothing — a real bug (the query, the skip-set bind, or a different
 *   population), which the log line must escalate rather than smooth over.
 */
export type StallCause = "all-parked" | "selectable-but-absent" | "unknown";

/**
 * The measured cause of a cycle that selected nothing. Two inputs, both
 * required for a sound claim:
 *
 * - `selectableRows`: ROW count the skip set did NOT exclude (from
 *   {@link classifyPendingLinks}). Zero means every row is parked, so the empty
 *   selection is correct.
 * - `probeFound`: whether re-running the SAME selection found anything. A
 *   positive `selectableRows` only proves rows exist — not that the selection
 *   missed them, since `selectableRows` is counted after the selection ran and
 *   rows may have landed in between. A non-empty probe refutes the "missed"
 *   claim outright: the backlog IS selectable, so this is not a stall.
 *
 * Returns `"unknown"` for that not-actually-stalled case, so the caller can
 * decline to raise the flag rather than publish a cause it cannot stand behind.
 * Pure, so the rule is testable without a DB.
 */
export function classifyStallCause(
  selectableRows: number,
  probeFound: number,
): StallCause {
  if (selectableRows === 0) return "all-parked";
  return probeFound === 0 ? "selectable-but-absent" : "unknown";
}

let stallCause: StallCause = "unknown";
/** Row breakdown from the last cycle that selected nothing (see lastCycle). */
let lastCycle: {
  pendingRows: number;
  selectableRows: number;
  parkedRows: number;
  backoffUrls: number;
  selected: number;
} | null = null;
/**
 * The stall cause last WRITTEN to the log, or null before the first line.
 *
 * The log guard compares against THIS, not against `backlogStuck`-scoped
 * state: the flag is cleared by any cycle that selects work, so comparing
 * against it would reset the comparison to `null` and re-log an UNCHANGED
 * cause whenever selection flaps.
 * The latch is cleared only by {@link clearStall} — i.e. by genuine recovery —
 * so a repeated cause is silent and a genuine re-stall is reported again.
 */
let loggedStallCause: StallCause | null = null;

/**
 * Whether {@link transientRetry} has been seeded from the PERSISTED retry
 * state (see {@link seedTransientRetry}). Reset by stop/reset, because
 * stopping clears the gate and a later start must rebuild it.
 */
let retryStateSeeded = false;

/**
 * Raise the backlog-stall flag and count the transition. Idempotent while the
 * flag is already set, so `backlogStuckSkipped` (and the stall's `since`) keep
 * describing the ONE stall rather than restarting on every cycle.
 */
function setStall(): void {
  if (backlogStuck) return;
  backlogStuck = true;
  backlogStuckSince = Date.now();
  backlogStuckSkipped = 0;
  statsBacklogStuckTransitions++;
  metricBacklogStuckTransitions.inc();
}

/**
 * Clear the backlog-stall flag and the measurements that describe it.
 *
 * Called ONLY on genuine recovery — the backlog drained, or rows SETTLED (left
 * `pending_links`) — never merely because a cycle selected work: a trickle of
 * expired backoff windows that fail transiently again selects work and changes
 * nothing, and clearing on it flaps the stall flag. The log latch resets
 * with it, because the next stall is then a NEW stall rather than a repeat of
 * the one just cleared.
 */
function clearStall(): void {
  if (backlogStuck) {
    statsBacklogStuckTransitions++;
    metricBacklogStuckTransitions.inc();
  }
  backlogStuck = false;
  backlogStuckSkipped = 0;
  stallCause = "unknown";
  lastCycle = null;
  loggedStallCause = null;
}
/**
 * Priority queue of freshly-detected live link URLs. Drained before the
 * oldest-first backlog so a newly posted link is enriched within seconds
 * instead of waiting behind thousands of historical (backfilled) pending
 * links. Populated by {@link pokeEmbedSweeper} from createMessage batches.
 */
const priorityLinks = new Set<string>();

/**
 * In-memory retry gate for TRANSIENT failures (timeout / 5xx / 429 / network).
 * A URL that fails transiently is kept pending (so it is eventually retried)
 * but is SKIPPED for an exponential backoff window, so the sweeper doesn't
 * re-fetch the same dead links every cycle and burn its concurrency on links
 * known to be down. `retryAt` is the epoch-ms before which the URL is skipped.
 * `attempts` tracks consecutive transient failures to escalate the backoff.
 * Mirrors the `retry_after`/`attempts` persisted in `comp_embed_link_data`,
 * but lives in-memory here so the global pending scan doesn't have to join
 * every per-space DB. Reset on ok/definitive outcomes and on stop; SEEDED from
 * those persisted columns at startup (see {@link seedTransientRetry}), so a
 * restart does not forget the backoff and re-fetch the whole backlog at once.
 */
const transientRetry = new Map<string, { attempts: number; retryAt: number }>();

export interface EmbedSweeperOpts {
  /** Global DB — the `pending_links` index lives here. */
  globalDb: DbLike;
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
  sweeperGlobalDb = opts.globalDb;
  sweeperRouter = opts.invalidationRouter;
  // Detached background loop — must never reject the process. Any throw is
  // logged and the loop continues (see inner try/catch per sweep).
  loopPromise = runSweeperLoop().catch((err) => {
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
  /** Null outcomes that SETTLED the row — definitive no-data / stable 4xx. */
  enrichedDefinitive: number;
  /** Null outcomes that left the row PENDING — transient (timeout/5xx/429/network). */
  enrichedTransient: number;
  /**
   * `enrichedDefinitive + enrichedTransient`. Kept because operators and the
   * readstate review doc read this name; the two components are the
   * actionable signal.
   */
  enrichedNull: number;
  /** Sweep cycles that ran a selection since start (the cycle RATE). */
  sweepCycles: number;
  /** Of those, the cycles the loop yielded after (full batch, no ok). */
  sweepThrottled: number;
  enrichmentDiffs: number;
  dbErrorCount: number;
  dbBackoffActive: boolean;
  /**
   * True when the backlog is non-empty but the sweeper selected nothing and
   * the oldest pending row is older than {@link STALL_AGE_MS}. This is the
   * signal the `pending`/`inFlight` pair cannot express: a stuck 5k-row
   * backlog looks idle. The CAUSE is not implied — read {@link lastStallCause}
   * and {@link lastCycle}. See /health/embed and `roomy_embed_backlog_stuck`.
   */
  backlogStuck: boolean;
  /** Epoch-ms the stall began (0 when not stuck). */
  backlogStuckSince: number;
  /** Sweep cycles the stall persisted through (no rows settled). */
  backlogStuckSkipped: number;
  /**
   * Times the flag above has CHANGED VALUE since start, both directions. A
   * high rate with a flat `enrichedOk` is the flap: the stall gauge
   * oscillating without the backlog moving.
   */
  backlogStuckTransitions: number;
  /**
   * Number of URLs currently inside a transient-retry backoff window
   * (`retryAt` in the future).
   *
   * URL-keyed, and the backlog is ROW-keyed, so this is NOT comparable to
   * `pending` by subtraction: one parked URL pending in N messages parks N
   * rows. `pending - transientBackoff` therefore over-reports selectable rows
   * and reads positive even when the whole backlog is parked. Use
   * {@link lastCycle}'s `selectableRows` for that question.
   */
  transientBackoff: number;
  /**
   * Measured reason the last cycle that selected nothing did so. `null` until
   * such a cycle has run. `"all-parked"` means every pending ROW was inside a
   * backoff window; `"selectable-but-absent"` means selectable rows existed
   * and the query returned nothing anyway — a real selection bug.
   */
  lastStallCause: StallCause | null;
  /** Row/URL breakdown of the last cycle that selected nothing (`null` until then). */
  lastCycle: {
    pendingRows: number;
    selectableRows: number;
    parkedRows: number;
    backoffUrls: number;
    selected: number;
  } | null;
} {
  return {
    priorityQueue: priorityLinks.size,
    inFlight: inFlightCount(),
    enrichedOk: statsEnrichedOk,
    enrichedDefinitive: statsEnrichedDefinitive,
    enrichedTransient: statsEnrichedTransient,
    enrichedNull: statsEnrichedDefinitive + statsEnrichedTransient,
    sweepCycles: statsSweepCycles,
    sweepThrottled: statsSweepThrottled,
    enrichmentDiffs: statsEnrichmentDiffs,
    dbErrorCount,
    dbBackoffActive: Date.now() < dbBackoffUntil,
    backlogStuck,
    backlogStuckSince,
    backlogStuckSkipped,
    backlogStuckTransitions: statsBacklogStuckTransitions,
    transientBackoff: activeBackoffSize(),
    lastStallCause: lastCycle === null ? null : stallCause,
    lastCycle,
  };
}

/**
 * Number of URLs currently parked in a transient-retry backoff window
 * (`retryAt` in the future). Exposed on /health/embed and in the periodic
 * metrics log so the stall is self-evident: `pending` large, `inFlight` 0,
 * `transientBackoff` large.
 */
function activeBackoffSize(): number {
  const now = Date.now();
  let n = 0;
  for (const retry of transientRetry.values()) {
    if (retry.retryAt > now) n++;
  }
  return n;
}

/**
 * Restore the in-memory retry gate from the PERSISTED retry state
 * (`comp_embed_link_data.retry_after`/`attempts`).
 *
 * Why this is needed: the gate is process-local, but the enricher already
 * WRITES `retry_after`/`attempts` for exactly this purpose and nothing ever
 * read them. A restart therefore dropped all backoff while `pending_links`
 * survived, making every parked row selectable at once and re-fetching the
 * whole backlog — re-paying a ~0.15% success rate instead of remembering it.
 *
 * Why the read side lives HERE, and not in the selection query: the retry
 * state is written per space while the work queue (`pending_links`) is global,
 * and `findPendingLinks` reads the global DB alone — it cannot join across the
 * separate per-space DBs. So the map is seeded once, from the spaces that
 * actually have pending rows (a space with none has nothing to park).
 *
 * Only rows whose window has NOT expired are restored: an expired `retry_after`
 * is selectable now, which is what the gate would say anyway. `attempts` is
 * carried over so the escalation resumes where the previous process left it
 * instead of restarting at the 1-minute step.
 */
async function seedTransientRetry(globalDb: DbLike): Promise<void> {
  const now = Date.now();
  const spaces = await globalDb
    .query(`select distinct space_did from pending_links`)
    .all<{ space_did: string }>();
  let restored = 0;
  for (const { space_did } of spaces) {
    try {
      const rows = await openSpaceDb(space_did)
        .query(
          `select entity, attempts, retry_after
             from comp_embed_link_data
            where retry_after is not null and retry_after > ?`,
        )
        .all<{ entity: string; attempts: number; retry_after: number }>([now]);
      for (const r of rows) {
        const existing = transientRetry.get(r.entity);
        // Never shorten a window this process already recorded.
        if (existing && existing.retryAt >= r.retry_after) continue;
        transientRetry.set(r.entity, {
          attempts: r.attempts,
          retryAt: r.retry_after,
        });
        restored++;
      }
    } catch (err) {
      // One unreadable space DB must not abort the seed — the sweeper
      // self-heals it on the next fetch. debug, not warn: one line per space
      // per start, never per cycle.
      log.debug(`[embed-sweeper] retry-state seed failed for ${space_did}:`, err);
    }
  }
  if (spaces.length > 0) {
    log.info(
      `[embed-sweeper] restored ${restored} parked URL(s) from ` +
        `${spaces.length} space(s) with pending links`,
    );
  }
}

/**
 * Idle-poll delay the loop uses after a cycle that selected nothing — the
 * pacing of the STALLED path.
 *
 * A fully parked backlog (`pending` non-zero, `selectableRows` 0,
 * `lastStallCause` all-parked) would otherwise take the plain
 * {@link IDLE_POLL_MS} idle branch forever: the batch is never "full", so the
 * full-batch throttle cannot engage, and every 30-second cycle runs the stall
 * diagnostic (one aggregate plus one probe, each binding a parameter per
 * parked URL) and re-offers the same log line.
 *
 * While the stall persists the poll escalates 30s → 60s → 120s → 240s → 300s
 * and stops at {@link STALL_POLL_MAX_MS}. Bounded on purpose: nothing wakes the
 * loop when a parked URL's window EXPIRES, so this poll is what notices, and
 * keying the escalation on the stall's AGE (hours) would delay the drain by
 * hours. `waitForWake` is used, so a poke for a freshly-posted link still cuts
 * any wait short. Healthy cycles keep the plain {@link IDLE_POLL_MS}.
 */
export function sweepIdleDelayMs(): number {
  if (!backlogStuck) return IDLE_POLL_MS;
  const step = Math.min(backlogStuckSkipped, 4);
  return Math.min(IDLE_POLL_MS * 2 ** step, STALL_POLL_MAX_MS);
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
export async function prioritiseLinksForRead(
  db: DbLike,
  messages: ReadonlyArray<
    Readonly<{ linkEmbeds: ReadonlyArray<{ url: string }> }>
  >,
): Promise<void> {
  const linkUrls = messages.flatMap((m) => m.linkEmbeds.map((l) => l.url));
  if (linkUrls.length === 0) return;
  try {
    const pending = await filterPendingUrls(db, linkUrls);
    if (pending.length > 0) pokeEmbedSweeper(pending);
  } catch (err) {
    // Embed prioritisation is best-effort: a transient DB error (e.g. a macOS
    // SQLITE_IOERR_VNODE from I/O pressure) must NEVER turn a successful
    // getMessages/getMessage into a 500. Messages are the product; embed cards
    // are a secondary enhancement. The sweeper's idle poll picks these links
    // up regardless, so skipping the poke on a DB hiccup is harmless.
    log.warn("[embed] prioritiseLinksForRead failed:", err);
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
  log.warn(
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

/**
 * What one sweep cycle did, in the two terms the loop's pacing needs.
 */
export interface SweepCycleResult {
  /** The batch was full ({@link SWEEP_BATCH} links) — more pending likely remain. */
  full: boolean;
  /** At least one link resolved to an ok embed this cycle. */
  producedOk: boolean;
}

/**
 * Run one sweep cycle: pull a priority + backlog batch, drain it with
 * bounded concurrency, and emit per-URL invalidations for successes. Returns
 * a {@link SweepCycleResult}: whether the batch was FULL (more pending likely
 * remain) and whether it produced any `ok` outcome. The loop uses that pair —
 * see {@link sweepYieldsAfter} — to choose between the no-wait path and the
 * anti-churn yield.
 *
 * Expected DB/fetch failures are caught inline (and drive the DB backoff via
 * `markDbError`). Any *unexpected* throw bubbles to {@link runSweeperLoop}'s
 * outer guard so the loop self-heals instead of dying.
 */
export async function sweepCycle(globalDb: DbLike): Promise<SweepCycleResult> {
  // Bail out early if the sweeper has been stopped (e.g. during test teardown).
  if (!started) return { full: false, producedOk: false };
  // If the DB has been erroring, wait out the backoff before touching it
  // again — don't fetch links only to fail every write (wastes embed-service
  // calls and spams logs). A poke can still wake us early, but we re-check
  // the backoff at the top of the next cycle.
  const now = Date.now();
  if (now < dbBackoffUntil) {
    await sweepWait(dbBackoffUntil - now);
    return { full: false, producedOk: false };
  }

  statsSweepCycles++;
  metricSweepCycles.inc();

  // One-shot: restore the persisted transient-retry state BEFORE the skip set
  // and the selection that use it. Without this a restart re-fetches every
  // parked URL at once (see seedTransientRetry). Failure just retries next
  // cycle — an unseeded gate selects more than necessary, it is not a hole.
  if (!retryStateSeeded) {
    try {
      await seedTransientRetry(globalDb);
      retryStateSeeded = true;
    } catch (err) {
      log.warn("[embed-sweeper] retry-state seed failed (will retry next cycle):", err);
    }
  }

  let pending: PendingLink[] = [];

  // URLs currently parked in a transient-retry backoff window. Computed once
  // per cycle (from the `now` above) and reused by BOTH the backlog query and
  // the stall diagnostic below, so the diagnostic measures against the exact
  // skip set the selection used — never a re-derived approximation.
  const backoffUrls = new Set<string>();
  for (const [url, retry] of transientRetry) {
    if (retry.retryAt > now) backoffUrls.add(url);
  }

  // 1. Priority: freshly-detected live links first, so a newly posted
  //    link is enriched within seconds instead of waiting behind the
  //    entire backfill backlog. Resolve which spaces each priority URL is
  //    still pending in via the global `pending_links` index.
  const priority = drainPriorityLinks(SWEEP_BATCH);
  if (priority.length > 0) {
    try {
      pending = await findPendingLinksForUrls(globalDb, priority);
    } catch (err) {
      log.warn("[embed-sweeper] findPendingLinksForUrls failed:", err);
      markDbError(err);
      pending = [];
    }
  }

  // 2. Backlog: fill the rest of the batch with the oldest pending links,
  //    EXCLUDING URLs currently in transient-retry backoff. Excluding them in
  //    the query (not just filtering the result) is what lets the sweeper
  //    advance past a run of down links instead of re-selecting the same
  //    oldest backoff links every cycle and stalling.
  if (pending.length < SWEEP_BATCH) {
    try {
      const backlog = await findPendingLinks(
        globalDb,
        SWEEP_BATCH - pending.length,
        backoffUrls,
      );
      // Dedupe in case a priority URL is also among the oldest pending
      // (rare — priority URLs are newest, backlog is oldest-first).
      pending = dedupePending([...pending, ...backlog]);
    } catch (err) {
      // A transient DB error shouldn't kill the loop. Back off so a
      // dead DB doesn't cause a tight fetch-and-fail cycle.
      log.warn("[embed-sweeper] findPendingLinks failed:", err);
      markDbError(err);
    }
  }

  // Skip any priority URLs currently in transient-retry backoff (the priority
  // path resolves spaces for freshly-poked URLs without a backoff filter).
  if (pending.length > 0) {
    const now = Date.now();
    pending = pending.filter((p) => {
      const retry = transientRetry.get(p.url);
      return !retry || retry.retryAt <= now;
    });
  }

  // Did this cycle resolve anything, and did it REMOVE rows from the backlog?
  // Both are reported to the loop: `producedOk` bounds the no-progress batch
  // rate (see {@link sweepYieldsAfter}), and `cycleSettledRows` is what proves
  // the queue is draining (see the hysteresis at the end of the cycle).
  let cycleProducedOk = false;
  // Whether this cycle actually REMOVED rows from the backlog (settled them).
  // A cycle that selected work but settled nothing made no progress, and must
  // not clear the stall flag (see the hysteresis at the end of the cycle).
  let cycleSettledRows = false;

  if (pending.length > 0) {
    // Group pending rows by URL → the set of spaces it is pending in (a URL
    // can appear in multiple spaces). enrichLinkAcrossSpaces fetches ONCE per
    // URL and stores the result to every space's DB.
    const spacesByUrl = new Map<string, string[]>();
    for (const p of pending) {
      const arr = spacesByUrl.get(p.url) ?? [];
      arr.push(p.spaceDid);
      spacesByUrl.set(p.url, arr);
    }

    // Drain the batch with bounded concurrency so N links complete in
    // ~ceil(N/CONCURRENCY) fetch round-trips rather than N. Each
    // enrichLinkAcrossSpaces is deduplicated (inFlightLinks) + timeout-bounded,
    // and resolves to the stored embed (null on failure).
    //
    // We stream invalidations per-URL as they SUCCEED (non-null embed): a
    // freshly-posted live link's card appears the moment ITS fetch resolves.
    // Failed (null) enrichments emit nothing. Per-URL error isolation keeps
    // one throwing enrichLinkAcrossSpaces from killing the whole loop.
    let cycleDbError: unknown = null;
    // URLs whose enrichment SUCCEEDED — emit invalidations and drop from the
    // pending set.
    const enrichedUrls = new Set<string>();
    // URLs that are SETTLED (ok OR definitive no-data) — drop from the
    // pending set so the backlog drains. Only transient failures stay pending
    // for a later retry.
    const settledUrls = new Set<string>();
    await mapWithConcurrency([...spacesByUrl.entries()], CONCURRENCY, async ([url, spaces]) => {
      let outcome: EnrichOutcome | null = null;
      try {
        outcome = await enrichLinkAcrossSpaces(url, spaces);
      } catch (err) {
        // enrichLinkAcrossSpaces only throws for DB (storeEmbedData) errors —
        // fetch errors are handled inside fetchEmbedData (returns a
        // FetchResult). Capture once per cycle to drive backoff (don't
        // escalate per-link). Logged at debug: a failing DB under I/O
        // pressure can throw per-link per-cycle, which floods logs.
        if (cycleDbError === null) cycleDbError = err;
        log.debug(`[embed-sweeper] enrichLinkAcrossSpaces threw for ${url}:`, err);
      }
      if (outcome?.status === "ok") {
        statsEnrichedOk++;
        metricEnrichedOk.inc();
        cycleProducedOk = true;
        enrichedUrls.add(url);
        settledUrls.add(url);
        transientRetry.delete(url);
        // Emit per-URL invalidation routed to each space's per-space DB.
        for (const spaceDid of spaces) {
          await emitEnrichmentInvalidation(openSpaceDb(spaceDid), spaceDid, [url]);
        }
      } else if (outcome?.status === "definitive") {
        // Settled no-data (page loaded but no OG/oEmbed, or a stable 4xx).
        // Drop from the pending set — re-fetching it every sweep would keep
        // the backlog pinned on dead links forever and starve real ones.
        statsEnrichedDefinitive++;
        metricEnrichedDefinitive.inc();
        settledUrls.add(url);
        transientRetry.delete(url);
      } else {
        // Transient (timeout / 5xx / 429 / network) — keep pending so it is
        // retried later, but skip it for an exponential backoff window so the
        // sweeper doesn't re-fetch the same down links every cycle.
        statsEnrichedTransient++;
        metricEnrichedTransient.inc();
        const prev = transientRetry.get(url);
        const attempts = (prev?.attempts ?? 0) + 1;
        transientRetry.set(url, { attempts, retryAt: Date.now() + backoffMs(attempts) });
      }
    });

    // Delete the processed rows from the global `pending_links` index. Both
    // successfully-enriched AND definitively-settled URLs are removed; only
    // transient failures stay pending for a later retry. Without this, a
    // backlog of dead/no-data links is re-fetched on every sweep and never
    // drains, so the sweeper never reaches newer real links.
    if (settledUrls.size > 0) {
      try {
        let deleted = 0;
        for (const p of pending) {
          if (!settledUrls.has(p.url)) continue;
          const res = await globalDb.run(
            `delete from pending_links where space_did = ? and url = ?`,
            [p.spaceDid, p.url],
          );
          deleted += res.changes;
        }
        // Rows actually LEFT the backlog — real progress, not churn. Counted
        // from `changes` rather than the batch's settled URLs: a row can be
        // gone already (another delete raced this one), and a cycle that
        // removed nothing has not moved the queue.
        if (deleted > 0) cycleSettledRows = true;
      } catch (err) {
        if (cycleDbError === null) cycleDbError = err;
      }
    }

    if (cycleDbError !== null) markDbError(cycleDbError);
    else markDbOk(); // a successful write cycle → DB is healthy again
  }

  // Stall detection: a cycle that selected NO links out of a NON-EMPTY,
  // stale backlog is doing no work, and the obvious in-memory signals stay
  // silent about it (`inFlight` 0, `dbBackoffActive` false). Record it so an
  // operator (or a Grafana alert on `roomy_embed_backlog_stuck`) can see it.
  // A cycle that selected work but settled NOTHING has made no progress
  // either — the trickle of expired backoff windows that fail transiently
  // again leaves the backlog exactly as it was — so it neither clears the
  // stall nor resets its counters (see `cycleSettledRows` and clearStall).
  //
  // The CAUSE is MEASURED here, never assumed. A fixed cause string of "all
  // pending links are in transient-retry backoff" is false whenever a parked
  // URL is pending in more than one message (the sweeper's backoff is keyed by
  // URL, the backlog by row).
  // `classifyPendingLinks` counts the ROWS the same skip set excludes, so the
  // numbers in the log line cannot disagree with what the query actually did.
  //
  // These queries run ONLY on a cycle that selected nothing — i.e. while
  // stalled, roughly one cheap indexed `min(created_at)` plus one aggregate per
  // idle poll — not on every cycle, so they cost nothing while healthy.
  if (pending.length === 0) {
    try {
      const row = await globalDb
        .query(`select min(created_at) as oldest from pending_links`)
        .get<{ oldest: number | null }>();
      const oldest = row?.oldest;
      if (oldest == null || Date.now() - oldest <= STALL_AGE_MS) {
        // Not a stall under this flag's own definition: either nothing is
        // pending (the backlog drained) or its oldest row is not yet stale.
        // Clear rather than keep an event that no longer describes the queue —
        // leaving the flag set would let `backlogStuckSince` outlive the
        // backlog it describes.
        if (backlogStuck) clearStall();
      } else {
        // Count the rows the SAME skip set excluded, via one aggregate.
        // `selectable` is computed over all rows at diagnostic time, so it
        // cannot be attributed to the earlier SELECT — a row inserted between
        // the two would make an "the query missed rows" claim unsound. Treat
        // the count as EVIDENCE about the backlog's shape and confirm it with
        // a probe that must find something if the claim is true.
        const { total, selectable, parked } = await classifyPendingLinks(
          globalDb,
          backoffUrls,
        );
        const numbers = () =>
          `pendingRows=${total} selectableRows=${selectable} ` +
          `parkedRows=${parked} backoffUrls=${backoffUrls.size} ` +
          `selected=${pending.length} stuckTransitions=${statsBacklogStuckTransitions}`;
        const age = Math.round((Date.now() - oldest) / 60_000);

        // `selectable > 0` says rows exist NOW that the skip set does not
        // cover. The only sound way to conclude the SELECT missed them is to
        // run that SELECT again, unchanged; a non-empty result PROVES it was a
        // transient/mid-cycle discrepancy (new rows arriving), not a bug. Only
        // when the repeat ALSO returns empty is the selection genuinely broken.
        const probe = await findPendingLinks(globalDb, SWEEP_BATCH, backoffUrls);
        const cause: StallCause = classifyStallCause(selectable, probe.length);

        if (cause !== "unknown") {
          stallCause = cause;
          lastCycle = {
            pendingRows: total,
            selectableRows: selectable,
            parkedRows: parked,
            backoffUrls: backoffUrls.size,
            selected: pending.length,
          };
          setStall();
          // Log once per cause TRANSITION, latched independently of the
          // `backlogStuck` flag's lifetime. The flag is cleared by any cycle
          // that selects work, so a guard comparing against flag-scoped state
          // resets on a 1→0→1 flap and re-logs an UNCHANGED cause. The latch is
          // cleared only by a GENUINE recovery (see clearStall), so a repeated
          // cause is silent and a new stall after real recovery is reported
          // again; `backlogStuckTransitions` makes any remaining flap countable.
          if (cause !== loggedStallCause) {
            loggedStallCause = cause;
            if (cause === "all-parked") {
              // Every pending row is inside a backoff window, so the empty
              // selection is correct and the backlog drains as windows expire.
              // Report the numbers so the next reader doesn't re-derive them.
              log.warn(
                `[embed-sweeper] backlog stalled: oldest pending row is ${age}m old ` +
                  `and the last cycle selected nothing — cause=all-parked (${numbers()})`,
              );
            } else {
              // A re-run of the selection returned nothing while selectable
              // rows exist: a real bug (the query, the skip-set bind, or the
              // two call sites reading different populations). ERROR, not warn
              // — a fixed-cause message would conceal it.
              log.error(
                `[embed-sweeper] backlog stalled: oldest pending row is ${age}m old ` +
                  `and the last cycle selected nothing — cause=selectable-but-absent ` +
                  `(a re-run of the backlog query returned none while rows outside ` +
                  `the backoff set exist) (${numbers()})`,
              );
            }
          }
        } else if (backlogStuck) {
          // The probe found selectable rows: the backlog is NOT stalled (the
          // empty selection was a transient race with in-flight inserts).
          // Clear the flag instead of publishing a cause that is not true.
          clearStall();
        }
      }
    } catch (err) {
      log.debug("[embed-sweeper] backlog-age probe failed:", err);
    }
  }

  // Keep the stall flag current, and count the cycles it persisted through.
  if (pending.length > 0) {
    if (cycleSettledRows) {
      // Rows left `pending_links` this cycle, so the queue IS draining — the
      // stall is over. A cycle that selected work but settled NOTHING (the
      // trickle of expired backoff windows that fail transiently again) has
      // changed nothing, and clearing the flag on it flaps the stall gauge and
      // resets the log latch.
      clearStall();
    } else if (backlogStuck) {
      // Still stalled and this cycle's work changed nothing — count it so the
      // idle poll can escalate (see {@link sweepIdleDelayMs}).
      backlogStuckSkipped++;
    }
  } else if (backlogStuck) {
    backlogStuckSkipped++;
  }

  // A full batch means there may be more pending; `producedOk` tells the loop
  // whether running the next batch immediately is progress or churn (see
  // sweepYieldsAfter).
  return {
    full: pending.length >= SWEEP_BATCH,
    producedOk: cycleProducedOk,
  };
}

async function runSweeperLoop(): Promise<void> {
  const globalDb = sweeperGlobalDb;
  if (!globalDb) return;

  for (;;) {
    if (!started) return; // allow clean exit via stopEmbedSweeper
    try {
      const result = await sweepCycle(globalDb);
      if (!result.full) {
        // Wait for a poke (new links) or the idle poll, whichever comes first.
        // This bounds latency for newly posted links while also self-healing
        // anything we missed (backfill, prior sessions). The delay escalates
        // while the backlog is stalled (see {@link sweepIdleDelayMs}).
        await sweepWait(sweepIdleDelayMs());
        continue;
      }
      // Full batch: more pending remain, so running the next batch immediately
      // is the deliberate latency optimisation for freshly-posted links — but
      // ONLY when this batch actually resolved something. A full batch that
      // produced no `ok` is churn (see sweepYieldsAfter): everything in it
      // either failed transiently (row stays pending) or settled as definitive
      // no-data, and the previous code ran the next batch back-to-back with no
      // wait at all, so the fetch rate was bounded only by the fetches
      // themselves. Yield first — on the same wait a poke uses, so a
      // freshly-posted link still cuts the wait short.
      if (!sweepYieldsAfter(result)) continue;
      statsSweepThrottled++;
      metricSweepThrottled.inc();
      await sweepWait(NO_OK_YIELD_MS);
    } catch (err) {
      // Outer resilience: the inner try/catches handle expected DB/fetch
      // failures, but any *unexpected* throw (a future code path not yet
      // guarded) must NOT permanently kill the process-wide loop — without
      // this, a single unhandled rejection would stop all embed enrichment
      // until restart. Log, pause briefly to avoid a tight crash loop, and
      // continue.
      log.error("[embed-sweeper] sweep cycle threw (continuing):", err);
      await sweepWait(IDLE_POLL_MS);
    }
  }
}

/**
 * Whether the loop must YIELD after a cycle instead of running the next one
 * back-to-back. Only a FULL batch that produced no `ok` outcome is throttled:
 *
 * - a full batch WITH an ok keeps the no-wait path — that is the deliberate
 *   latency optimisation for freshly-posted links, and a batch that is
 *   resolving real links should drain as fast as the fetches allow;
 * - a full batch with NO ok resolved nothing: running the next batch
 *   immediately only spends more of the box's time and more outbound requests
 *   producing the same result.
 *
 * Pure, so the rule is testable without starting the loop.
 */
export function sweepYieldsAfter(result: SweepCycleResult): boolean {
  return result.full && !result.producedOk;
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

/**
 * Dedupe pending rows by (spaceDid, url) so the same URL isn't enriched twice
 * in the same space within one batch (a URL can be pending under multiple
 * message ids in the same space).
 */
function dedupePending(links: PendingLink[]): PendingLink[] {
  const seen = new Set<string>();
  const out: PendingLink[] = [];
  for (const l of links) {
    const key = `${l.spaceDid}\u0000${l.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
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

/**
 * Resolve after `ms`, or immediately when {@link pokeEmbedSweeper} fires.
 */
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

/**
 * The loop's wait — the real {@link waitForWake} unless a test injects its
 * own via {@link _setSweepWaitForTest}. Indirection exists so a test can
 * drive the loop's pacing deterministically: fake timers cannot, because Bun
 * fakes `setImmediate`/`process.nextTick` too, which the SQLite worker's
 * round-trips need to progress, so a fake-timer test deadlocks the DB instead
 * of advancing the loop.
 */
let sweepWait: (ms: number) => Promise<void> = waitForWake;

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
 * any frame missing a required field. Reactions are re-read from
 * `comp_reaction` (unchanged by enrichment); `myReactionId` is intentionally
 * omitted (broadcast diffs can't be per-user) — the client derives
 * "did I react?" from `reaction.myReactionId`, so this doesn't affect rendering.
 */
/** Build a query-invalidation signal for a links endpoint the enrichment updates. */
function invalidate(nsid: QueryNsid, params: Record<string, string>): InvalidationEvent {
  return { kind: "queryInvalidation", signal: { nsid, params } };
}

async function emitEnrichmentInvalidation(
  db: DbLike,
  spaceDid: string,
  enrichedUrls: string[],
): Promise<void> {
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
    rows = await db
      .query(
        `select link.room as messageId, msg.room as roomId
           from entities link
           join entities msg on msg.id = link.room
          where link.id in (${placeholders})
            and msg.room is not null`,
      )
      .all<{ messageId: string; roomId: string }>([...enrichedUrls]);
  } catch (err) {
    log.warn("[embed-sweeper] room lookup failed:", err);
    return;
  }

  if (rows.length === 0) return;
  const messageIdToRoom = new Map(rows.map((r) => [r.messageId, r.roomId]));

  // Map each message id → its real room id (a URL may appear in multiple
  // messages; a message may contain multiple enriched URLs).
  let messages: MessageDto[] = [];
  try {
    messages = (await selectMessages(db, {
      kind: "ids",
      ids: [...messageIdToRoom.keys()],
    })).messages;
  } catch (err) {
    log.warn("[embed-sweeper] selectMessages failed:", err);
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
    // Enrichment just populated this room's cards — the room link index's
    // enriched data changed.
    signals.push(invalidate("space.roomy.room.getLinks", { roomId: roomId as string }));
  }
  // The space link index gains the freshly-enriched card for this space.
  signals.push(invalidate("space.roomy.space.getLinks", { spaceId: spaceDid }));

  statsEnrichmentDiffs += signals.length;
  sweeperRouter.emit(signals);
}

// ─── Test helpers ───────────────────────────────────────────────────────
/**
 * Replace the loop's wait, for tests that need to control pacing without
 * wall-clock delays. Pass `null` to restore the real `waitForWake`. The
 * injected function MUST resolve eventually (`stopEmbedSweeper` cannot wake a
 * wait that ignores {@link pokeEmbedSweeper}), or the loop stays parked.
 */
export function _setSweepWaitForTest(fn: ((ms: number) => Promise<void>) | null): void {
  sweepWait = fn ?? waitForWake;
}

/**
 * Mark the sweeper as started WITHOUT launching the background loop. Tests
 * only: tests that drive `sweepCycle` directly (instead of the real loop)
 * still need `started === true` for the cycle to run, but must NOT spawn a
 * concurrent background loop — otherwise the loop's `waitForWake` and the
 * shared `wake` singleton race the manual `sweepCycle` calls and the test
 * hangs under parallel-suite CPU contention (a 30s idle poll stretches well
 * beyond the 5s default timeout). Use this instead of `startEmbedSweeper`
 * in tests that call `sweepCycle` themselves.
 */
export function _startSweeperNoLoop(opts: EmbedSweeperOpts): void {
  started = true;
  sweeperGlobalDb = opts.globalDb;
  sweeperRouter = opts.invalidationRouter;
}

/**
 * Reset the sweeper singleton (does not cancel an already-running loop).
 * Tests only — clears state so a fresh `startEmbedSweeper` can be issued.
 */
export function _resetEmbedSweeper(): void {
  started = false;
  sweeperGlobalDb = undefined;
  sweeperRouter = undefined;
  wake = null;
  priorityLinks.clear();
  transientRetry.clear();
  dbErrorCount = 0;
  dbBackoffUntil = 0;
  statsEnrichedOk = 0;
  statsEnrichedDefinitive = 0;
  statsEnrichedTransient = 0;
  statsEnrichmentDiffs = 0;
  statsSweepCycles = 0;
  statsSweepThrottled = 0;
  backlogStuck = false;
  backlogStuckSince = 0;
  backlogStuckSkipped = 0;
  stallCause = "unknown";
  lastCycle = null;
  loggedStallCause = null;
  retryStateSeeded = false;
  statsBacklogStuckTransitions = 0;
  // A test that injected a wait must not leak it into the next test — a wait
  // that never resolves would park that test's loop forever.
  sweepWait = waitForWake;
}

/**
 * Stop the background sweeper loop. Idempotent. Used by tests to prevent
 * the loop from running after the DB is closed. Signals the loop to exit
 * and returns a promise that resolves once the loop has finished (with a
 * short timeout as a safety net).
 */
export function stopEmbedSweeper(): Promise<void> {
  started = false;
  sweeperGlobalDb = undefined;
  sweeperRouter = undefined;
  const w = wake;
  wake = null;
  w?.(); // wake the loop so it sees `started = false` and exits
  priorityLinks.clear();
  transientRetry.clear();
  // Stopping clears the gate, so a later start must rebuild it from the
  // persisted retry state (see seedTransientRetry).
  retryStateSeeded = false;
  loggedStallCause = null;
  statsBacklogStuckTransitions = 0;
  dbErrorCount = 0;
  dbBackoffUntil = 0;
  statsEnrichedOk = 0;
  statsEnrichedDefinitive = 0;
  statsEnrichedTransient = 0;
  statsEnrichmentDiffs = 0;
  statsSweepCycles = 0;
  statsSweepThrottled = 0;
  const timeout = Promise.withResolvers<void>();
  setTimeout(timeout.resolve, 50);
  return Promise.race([loopPromise ?? Promise.resolve(), timeout.promise]);
}
