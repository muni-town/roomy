/**
 * Fatal-exit visibility: record *why* the process died, then die.
 *
 * Bun aborts the process on an uncaught exception or an unhandled rejection,
 * but that abort writes a raw stderr trace which never reaches the app's Loki
 * sink: the cause exists only as container stdout noise, and is gone when the
 * container goes away.
 *
 * Two gaps, both closed here:
 *
 *   1. `installFatalHandlers()` records the fatal through the structured
 *      logger (scope `fatal`, `fatal: true`, error name/message/stack) and then
 *      exits non-zero. Installing a `process.on` listener SUPPRESSES Bun's own
 *      abort, so the handler must exit explicitly. Returning instead would
 *      swallow the crash and leave a process serving requests in an undefined
 *      state.
 *   2. `recordProcessStart()` increments `roomy_process_starts_total` once at
 *      boot, exposing a restart loop as a scrape-visible signal:
 *
 *        increase(roomy_process_starts_total[10m]) > 3
 *
 * Deliberately NOT here: signal handling / graceful shutdown. The container
 * runs under `litestream replicate`, which forwards signals to Bun and leaves
 * Bun's default terminate as the shutdown, and no `src/` module installs a
 * competing SIGTERM handler. The exit code is non-zero, so a supervisor's
 * restart policy (`Restart=always`, Railway's restart) still restarts the
 * process.
 */

import { log, flushLogs } from "./log.ts";
import { metrics } from "./metrics.ts";

/** Non-zero so a supervisor's restart policy sees a crash, matching the exit
 *  code Bun's own abort on an uncaught throw produces. */
const FATAL_EXIT_CODE = 1;

/** Bound on the Loki flush before the forced exit. The record of *why* the
 *  process died is worth a short wait for the batched sink, but a dead Alloy
 *  must never keep the process alive. */
const FATAL_FLUSH_TIMEOUT_MS = 2_000;

// Registered at module load (i.e. by the entry point importing this file), not
// lazily on first boot, so the family is always present in a scrape: a process
// that has never restarted still exposes `roomy_process_starts_total 1` rather
// than no series at all.
const processStarts = metrics.counter(
  "roomy_process_starts_total",
  "Process boots (incremented once per process at startup). A restart loop shows as a rising rate: increase(roomy_process_starts_total[10m]) > 3.",
);

/**
 * Count this process's boot. Call once, before anything else can fail.
 *
 * Deliberately not called from `createAppserver`: the registry keys families by
 * name, so registering again would reset the family's samples, and tests call
 * the factory many times inside a single process. One boot per process is the
 * signal being measured, and the process entry point is the only place that
 * knows it.
 */
export function recordProcessStart(): void {
  processStarts.inc();
}

/**
 * Coerce a rejection reason into an `Error` so the fatal record always carries
 * a message and a stack. Rejections are not required to be `Error`s — a
 * rejected plain object is serialized rather than flattened to
 * `[object Object]`, which would lose the only detail available.
 */
function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  let text: string;
  try {
    const json: string | undefined = JSON.stringify(reason);
    text = json === undefined ? String(reason) : json;
  } catch {
    text = String(reason); // circular or otherwise non-serializable reason
  }
  return new Error(text);
}

/** Guards against re-entry while the first fatal is still flushing: a rejection
 *  raised by the flush itself must not queue a second exit or bury the cause. */
let exiting = false;

function handleFatal(
  kind: "uncaughtException" | "unhandledRejection",
  reason: unknown,
): void {
  if (exiting) return;
  exiting = true;

  const error = toError(reason);
  try {
    log.error(
      `[fatal] ${kind}: exiting ${FATAL_EXIT_CODE}`,
      {
        fatal: true,
        kind,
        // `error.message`/`error.stack` are serialized by `log.ts`; the name
        // rides as a field so a reader can tell a TypeError from a rejected
        // non-Error.
        error_name: error.name,
        pid: process.pid,
        uptime_seconds: Math.round(process.uptime()),
      },
      error,
    );
  } catch (logErr) {
    // Logging must never be the reason the cause disappears: fall back to raw
    // stderr, which is still captured by the container log drain.
    try {
      console.error(
        `[fatal] ${kind}: exiting ${FATAL_EXIT_CODE}: ${error.stack ?? error.message}`,
        logErr,
      );
    } catch {
      // Nothing left to try; exit below regardless.
    }
  }

  // Hard deadline. Ref'd on purpose: an unref'd timer would let the event loop
  // drain and exit 0, masking the fatality as a clean shutdown.
  const hardExit = setTimeout(() => process.exit(FATAL_EXIT_CODE), FATAL_FLUSH_TIMEOUT_MS);
  // `finally` (not `.then(onFulfilled, onRejected)`): both outcomes exit, so
  // a rejection from the flush must not skip the exit — and an unconditional
  // finalizer keeps the two paths from drifting apart.
  void flushLogs(FATAL_FLUSH_TIMEOUT_MS).finally(() => {
    clearTimeout(hardExit);
    process.exit(FATAL_EXIT_CODE);
  });
}

/**
 * The subset of `process` this module registers on. Narrowed to a named
 * interface so tests can assert the registration contract against a stand-in
 * — installing the real handlers in the test runner would make an unrelated
 * unhandled rejection anywhere in the suite `process.exit(1)` and truncate the
 * run, hiding results.
 */
export interface FatalEventEmitter {
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

/** Emitters already installed on, so a second call for the same emitter is a
 *  no-op. Keyed per emitter rather than a single flag: the entry point installs
 *  once on `process`, and a test asking for its own stand-in must still get a
 *  registration rather than silently inheriting the earlier call's state. */
const installedOn = new WeakSet<FatalEventEmitter>();

/**
 * Install the fatal handlers. Idempotent per emitter; call once, as the first
 * statement of the entry point — before any top-level `await`, so a boot
 * failure (DB open, migration, factory construction) is recorded too, not just
 * a failure while serving.
 *
 * `emitter` defaults to `process`; the parameter exists so tests can assert the
 * registration without arming the handlers in the test runner.
 */
export function installFatalHandlers(emitter: FatalEventEmitter = process): void {
  if (installedOn.has(emitter)) return;
  installedOn.add(emitter);
  emitter.on("uncaughtException", (err) => handleFatal("uncaughtException", err));
  emitter.on("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason));
}
