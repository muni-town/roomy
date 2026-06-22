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
import { enrichLink, findPendingLinks } from "./enricher.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
} from "../invalidation/types.ts";

// ─── Configuration ──────────────────────────────────────────────────────

/** Max pending links to pull from the DB per sweep batch. */
const SWEEP_BATCH = 25;
/** How often to poll for pending links while idle (no pokes). */
const IDLE_POLL_MS = 30_000;

// ─── Singleton state ────────────────────────────────────────────────────

let sweeperDb: Database | undefined;
let sweeperRouter: InvalidationRouter | undefined;
let started = false;
/**
 * Resolved by {@link pokeEmbedSweeper} to wake an idle loop immediately.
 * Null when the loop is busy draining (so extra pokes are cheap no-ops).
 */
let wake: (() => void) | null = null;

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
    console.error("[embed-sweeper] loop crashed:", err);
  });
}

/**
 * Wake the sweeper to drain pending links immediately. Cheap and safe to
 * call frequently: if a sweep is already in progress this is a no-op.
 */
export function pokeEmbedSweeper(): void {
  if (wake) {
    const fn = wake;
    wake = null;
    fn();
  }
}

// ─── Loop ───────────────────────────────────────────────────────────────

async function runSweeperLoop(): Promise<void> {
  const db = sweeperDb;
  if (!db) return;

  for (;;) {
    let pending: string[] = [];
    try {
      pending = findPendingLinks(db, SWEEP_BATCH);
    } catch (err) {
      // A transient DB error shouldn't kill the loop.
      console.warn("[embed-sweeper] findPendingLinks failed:", err);
    }

    if (pending.length > 0) {
      for (const url of pending) {
        // enrichLink is deduplicated + timeout-bounded; failures are
        // swallowed inside (a null row is written so the URL leaves the
        // pending set rather than being retried every sweep).
        try {
          await enrichLink(db, url);
        } catch (err) {
          console.warn(`[embed-sweeper] enrichLink threw for ${url}:`, err);
        }
      }
      emitEnrichmentInvalidation(db, pending);
    }

    // A full batch means there may be more pending — loop without waiting.
    if (pending.length >= SWEEP_BATCH) continue;

    // Otherwise wait for a poke (new links) or the idle poll, whichever
    // comes first. This bounds latency for newly posted links while also
    // self-healing anything we missed (backfill, prior sessions).
    await waitForWake(IDLE_POLL_MS);
  }
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
 * After enrichment, emit per-room `getMessages` invalidation for the rooms
 * containing messages that reference the enriched URLs, so connected
 * clients re-fetch messages carrying the new embed data.
 *
 * `entities.room` holds the message id that contained the link (see
 * `detectAndStoreLinks`); each distinct value becomes one invalidation
 * signal. (This mapping is preserved verbatim from the original
 * implementation.)
 */
function emitEnrichmentInvalidation(
  db: Database,
  enrichedUrls: string[],
): void {
  if (!sweeperRouter || enrichedUrls.length === 0) return;

  const placeholders = enrichedUrls.map(() => "?").join(",");
  let roomRows: { room: string }[] = [];
  try {
    // Two-hop resolution: link entity → its `room` (message id) →
    // message entity → its `room` (the real room id).
    //
    // Media/link entities store `room = messageId` (see ensureEntity calls
    // in the SDK message materializer and detectAndStoreLinks), NOT the
    // room id. A single-hop lookup (as the original code did) yields the
    // message id and emits getMessages?roomId=<messageId> — which never
    // matches any client subscription, so clients never re-fetch.
    roomRows = db
      .query<{ room: string }, string[]>(
        `select distinct msg.room as room
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

  if (roomRows.length === 0) return;

  const roomIds = new Set(roomRows.map((r) => r.room));
  const signals: InvalidationEvent[] = [];
  for (const roomId of roomIds) {
    signals.push({
      kind: "queryInvalidation",
      signal: {
        nsid: "space.roomy.room.getMessages",
        params: { roomId },
      },
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
}
