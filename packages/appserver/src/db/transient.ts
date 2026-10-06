/**
 * Transient DB failures: the request never reached the database, or the worker
 * gave up on it while it was still running.
 *
 * `AsyncDatabase` bounds every worker request at `REQUEST_TIMEOUT_MS` and
 * rejects with "Request timed out: <type>" when the budget elapses. The worker
 * thread keeps running the request, and — unlike a write — a read that timed
 * out is safe to issue again: it has no effect to duplicate. Treating the
 * rejection as transient is what lets a caller retry instead of abandoning work
 * that is merely slow.
 */

/** Whether `err` is a DB request that timed out and can be issued again. */
export function isTransientDbError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Request timed out:");
}
