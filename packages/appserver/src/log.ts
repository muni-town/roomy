/**
 * Structured leveled logger gated by the `LOG_LEVEL` env var.
 *
 * Emits one JSON object per line to stdout:
 *   {ts, level, scope, msg, ...fields, error?, build_id, service}
 *
 * Why this exists: best-effort paths (embed fetch failures, per-DID backfill
 * progress, per-stream subscribe debug) can emit thousands of lines per
 * minute. On platforms that rate-limit stdout (e.g. Railway's 500 logs/sec
 * replica cap), that flood gets the real signal dropped — observability
 * collapses. Centralising the level here lets those paths be silenced
 * without touching every call site, and lets operators turn them back on
 * with `LOG_LEVEL=debug` when investigating a specific issue.
 *
 * Levels (threshold inclusive): debug < info < warn < error. Default `info`.
 * Anything emitted at a level below the threshold is dropped silently.
 *
 * Two sinks:
 *   1. stdout — one JSON object per line (the format above).
 *   2. Loki (optional) — when `ALLOY_URL` is set, records are batched and
 *      POSTed to the Alloy Loki push API (see `./telemetry/loki.ts`). The
 *      Loki sink never throws or blocks; it is disabled when `ALLOY_URL` is
 *      unset (dev default: stdout only).
 *
 * Call-site convention: `log.info(scope, msg, fields?)` or
 * `log.info("[scope] msg", err?)`. A leading `[scope]` prefix in the first
 * string becomes the `scope` field; a trailing `Error` becomes `error`.
 */

import { createLokiSink, type LokiSink } from "./telemetry/loki.ts";
import { resolveBuildId } from "./telemetry/build.ts";
import { currentTraceContext } from "./telemetry/tracing.ts";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const SERVICE = "appserver";

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw in LEVELS ? (raw as LogLevel) : "info";
}

interface ParsedArgs {
  scope: string;
  msg: string;
  fields: Record<string, unknown>;
  error?: Error;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(args: unknown[]): ParsedArgs {
  let scope = "app";
  let msg = "";
  const fields: Record<string, unknown> = {};
  let error: Error | undefined;

  const rest = [...args];
  const first = rest.shift();
  if (typeof first === "string") {
    const bracket = first.match(/^\[([^\]]+)\]\s*(.*)$/s);
    if (bracket) {
      scope = bracket[1]!;
      msg = bracket[2] ?? "";
    } else if (rest.length > 0 && !(rest[0] instanceof Error)) {
      // `log.info(scope, msg, fields?)` — but `log.error("msg", err)` keeps
      // the string as the message.
      scope = first;
    } else {
      msg = first;
    }
  } else if (first !== undefined) {
    rest.unshift(first);
  }

  for (const arg of rest) {
    if (arg instanceof Error) {
      error = arg;
    } else if (typeof arg === "string") {
      msg = msg.length === 0 ? arg : `${msg} ${arg}`;
    } else if (isPlainObject(arg)) {
      Object.assign(fields, arg);
    } else if (arg !== undefined) {
      msg = msg.length === 0 ? String(arg) : `${msg} ${String(arg)}`;
    }
  }
  return { scope, msg, fields, error };
}

function emit(level: LogLevel, args: unknown[]): void {
  if (LEVELS[level] < LEVELS[resolveLevel()]) return;

  const { scope, msg, fields, error } = parseArgs(args);
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...fields,
    build_id: resolveBuildId(),
    service: SERVICE,
  };
  if (error) {
    record.error = {
      message: error.message,
      stack: error.stack,
    };
  }
  // Correlate this log line with its trace so Grafana can pivot log → trace.
  // Null when tracing is off or outside a request, in which case the fields
  // are omitted entirely (never all-zero placeholder ids).
  const traceCtx = currentTraceContext();
  if (traceCtx) {
    record.trace_id = traceCtx.traceId;
    record.span_id = traceCtx.spanId;
  }
  const line = JSON.stringify(record);

  const sink =
    level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  sink(line);

  const labels: Record<string, string> = {
    service_name: SERVICE,
    level,
    scope,
  };
  const replicaId = process.env.RAILWAY_REPLICA_ID;
  if (replicaId) labels.replica_id = replicaId;
  const railwayServiceName = process.env.RAILWAY_SERVICE_NAME;
  if (railwayServiceName) labels.railway_service_name = railwayServiceName;

  lokiSink?.push({ line, labels, ts: Date.now() });
}

let lokiSink: LokiSink | null = createLokiSink();

/** Test-only: replace the Loki sink (e.g. with a mock or a sink pointed at a
 *  mock HTTP server). Pass `null` to disable. */
export function _setLokiSink(sink: LokiSink | null): void {
  lokiSink?.stop();
  lokiSink = sink;
}

/**
 * Flush the Loki sink's queue, bounded by `timeoutMs` so a dead Alloy can
 * never hold the caller open. Used by the fatal-exit path (`fatal.ts`) to get
 * the record of *why* the process died into Loki before it exits.
 *
 * Bounded for a different reason than it looks: the sink's own `flush()` is
 * already fire-and-forget and swallows its errors, so the race is not a
 * correctness backstop — it stops a *stuck* flush (unresolved fetch) from
 * holding the exit. Never rejects, so the caller cannot turn a logging
 * problem into a second failure while handling the first.
 *
 * No-op when the sink is disabled (no `ALLOY_URL`).
 */
export function flushLogs(timeoutMs: number): Promise<void> {
  const sink = lokiSink;
  if (sink === null) return Promise.resolve();
  return Promise.race([
    sink.flush().catch(() => {}),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
}

export const log = {
  debug: (...args: unknown[]): void => emit("debug", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
};
