/**
 * Structured leveled logger gated by the `LOG_LEVEL` env var.
 *
 * Emits one JSON object per line:
 *   {ts, level, scope, msg, ...fields, error?, build_id, service}
 *
 * Why this exists: best-effort paths (backfill progress, per-message
 * routing debug, per-stream subscribe) can emit thousands of lines per
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
 * Call-site convention: `log.info("msg", fields?)` or
 * `log.error("msg", err)`. A trailing `Error` becomes the `error` field; a
 * trailing plain object is spread into the record as extra fields; a
 * trailing string is appended to the message.
 */

import { createLokiSink, type LokiSink } from "./telemetry/loki.ts";
import { resolveBuildId } from "./telemetry/build.ts";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const SERVICE = "discord-bridge";

function resolveLevel(): LogLevel {
	const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
	return raw in LEVELS ? (raw as LogLevel) : "info";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emit(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
	if (LEVELS[level] < LEVELS[resolveLevel()]) return;

	const record: Record<string, unknown> = {
		ts: new Date().toISOString(),
		level,
		scope,
		msg,
		build_id: resolveBuildId(),
		service: SERVICE,
	};
	if (extra instanceof Error) {
		record.error = {
			message: extra.message,
			stack: extra.stack,
		};
	} else if (typeof extra === "string") {
		record.msg = msg.length === 0 ? extra : `${msg} ${extra}`;
	} else if (isPlainObject(extra)) {
		Object.assign(record, extra);
	} else if (extra !== undefined) {
		record.msg = msg.length === 0 ? String(extra) : `${msg} ${String(extra)}`;
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

export interface Logger {
	debug(msg: string, extra?: unknown): void;
	info(msg: string, extra?: unknown): void;
	warn(msg: string, extra?: unknown): void;
	error(msg: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
	return {
		debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
		info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
		warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
		error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
	};
}
