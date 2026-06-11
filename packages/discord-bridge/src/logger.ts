import { type Level, LOG_LEVEL } from "./env.ts";

const order: Record<Level, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};
const level = LOG_LEVEL();
const threshold = order[level];

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
	if (order[level] < threshold) return;
	const ts = new Date().toISOString();
	const base = `${ts} [${level.toUpperCase()}] [${scope}] ${msg}`;
	if (extra !== undefined) {
		console.log(base, extra);
	} else {
		console.log(base);
	}
}

export function createLogger(scope: string) {
	return {
		debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
		info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
		warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
		error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
	};
}

export type Logger = ReturnType<typeof createLogger>;
