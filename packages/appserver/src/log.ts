/**
 * Tiny leveled logger gated by the `LOG_LEVEL` env var.
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
 * This is intentionally minimal — it wraps `console.*` so output format and
 * destinations are unchanged. It is NOT a structured logger; pair it with a
 * non-rate-limited log sink (Loki/Grafana) for production observability.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw in LEVELS ? (raw as LogLevel) : "info";
}

const threshold = LEVELS[resolveLevel()];

function emit(level: LogLevel, sink: (...args: unknown[]) => void, args: unknown[]): void {
  if (LEVELS[level] >= threshold) sink(...args);
}

export const log = {
  debug: (...args: unknown[]): void => emit("debug", console.log, args),
  info: (...args: unknown[]): void => emit("info", console.info, args),
  warn: (...args: unknown[]): void => emit("warn", console.warn, args),
  error: (...args: unknown[]): void => emit("error", console.error, args),
};

