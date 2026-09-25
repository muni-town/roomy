/**
 * Freshness gate for push delivery.
 *
 * A push is a *live* signal: "this just happened". The only other candidate
 * time a message carries is `decodeTime(event.id)` — the event **ULID**, i.e.
 * when the event was *ingested*, not when the message was written. A replay of
 * historical messages therefore carries fresh ULIDs with hours-old content,
 * and every downstream gate would treat those as new.
 *
 * The Discord bridge's `runBackfill` replay (`cursor: none`, historical
 * Discord messages) delivers history over the live `sendEvents` path. It is
 * serial and slow — a low per-second rate — but *every* replayed message would
 * otherwise produce an immediate `busy` push and re-arm `engaged` digest
 * batches, regardless of its true age.
 *
 * The gate keys on the **canonical message timestamp** —
 * `canonicalMessageTimestamp` (see `materialization/sortIdx.ts`), which
 * honours `timestampOverride` for bridged messages — never the event ULID.
 * That is the only time value that distinguishes "old message, ingested
 * now" from "new message".
 *
 * Undecodable ULIDs fall back to "fresh": this is an *age* check, so a job
 * whose age cannot be determined must not be dropped — silently losing live
 * notifications is the opposite failure and a worse one. An undecodable
 * event id is not a replay signature.
 */

import { decodeTime } from "ulidx";

/**
 * How old a message may be and still produce a push.
 *
 * This window absorbs clock skew and pipeline latency between a user hitting
 * send and the message reaching this process — it does not batch anything.
 * The live path measures 0–28s end-to-end in production, so 5 minutes is ~10x
 * the observed worst case and cannot clip a genuine live message.
 *
 * A replay of historical content is hours-to-days old, so the window is chosen
 * for operator headroom rather than to separate a replay from live traffic.
 */
export const PUSH_MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;

/**
 * How long a pending digest batch may sit before the sweep drops it instead
 * of firing it.
 *
 * A digest answers "you missed something while you were away" — that question
 * is answerable for a while, then the batch is simply history. 24h is wide
 * enough to cover a normal overnight absence (the case digests exist for) and
 * far narrower than a replayed historical backlog.
 *
 * The sweep's 1h `DIGEST_WINDOW_MS` still governs *when* a fresh batch fires;
 * this constant only decides when a batch is too old to be worth firing at
 * all, which is what makes the sweep safe to run on every restart.
 */
export const PUSH_MAX_DIGEST_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * True when a message is fresh enough to notify about.
 *
 * A timestamp further in the future than the skew window is treated as
 * stale: a message cannot be "newer than now", so such a row is corrupt
 * rather than live.
 *
 * `now` is injectable for deterministic tests.
 */
export function isPushFresh(
  job: { canonicalTimestamp?: number; messageId: string },
  now: number = Date.now(),
): boolean {
  let timestamp: number;
  if (typeof job.canonicalTimestamp === "number" && Number.isFinite(job.canonicalTimestamp)) {
    timestamp = job.canonicalTimestamp;
  } else {
    try {
      timestamp = decodeTime(job.messageId);
    } catch {
      return true; // age unknown → do not drop a potential live notification
    }
  }
  const age = now - timestamp;
  return age <= PUSH_MAX_MESSAGE_AGE_MS && age >= -PUSH_MAX_MESSAGE_AGE_MS;
}
