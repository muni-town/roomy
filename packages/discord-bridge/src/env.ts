import { type } from "arktype";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} environment variable not provided.`);
	return value;
}

function optional(name: string, fallback: string): string {
	const value = process.env[name];
	return value && value.length > 0 ? value : fallback;
}

/** Lazily-evaluated env vars. Only triggers "not provided" error when accessed. */
export const DISCORD_TOKEN = () => required("DISCORD_TOKEN");
export const ATPROTO_BRIDGE_DID = () => required("ATPROTO_BRIDGE_DID");
export const ATPROTO_BRIDGE_APP_PASSWORD = () =>
	required("ATPROTO_BRIDGE_APP_PASSWORD");

export const APPSERVER_URL = () => required("APPSERVER_URL");
export const APPSERVER_DID = () => required("APPSERVER_DID");
/** Derived from APPSERVER_URL: HTTP origin → sync WebSocket URL.
 *  Matches app-lite's convention (http(s):// → ws(s):// + /xrpc/space.roomy.sync.subscribe). */
export const APPSERVER_WS_URL = () => {
	const origin = APPSERVER_URL().replace(/\/+$/, "");
	return `${origin.replace(/^http(s?):\/\//, "ws$1://")}/xrpc/space.roomy.sync.subscribe`;
};

export const STREAM_NSID = () =>
	optional("STREAM_NSID", "space.roomy.space.personal.dev");
export const STREAM_HANDLE_NSID = () =>
	optional("STREAM_HANDLE_NSID", "space.roomy.space.handle.dev");

export const BRIDGE_DATA_DIR = () => optional("BRIDGE_DATA_DIR", "./data");

/**
 * Reconnect backoff for live Roomy sync connections (ms).
 *
 * The bridge holds one live WebSocket per bridged space. When the appserver
 * is failing, every connection drops and the SDK schedules a reconnect. These
 * two knobs bound the shared circuit-breaker backoff (see live-gateway.ts):
 * the base delay for the first failure and the maximum cap. Defaults are
 * deliberately conservative (5s base, 5min cap) so a degraded appserver
 * isn't hammered by a synchronized reconnect storm.
 */
export const BRIDGE_RECONNECT_BASE_MS = () =>
	parseInt(optional("BRIDGE_RECONNECT_BASE_MS", "5000"), 10);
export const BRIDGE_RECONNECT_MAX_MS = () =>
	parseInt(optional("BRIDGE_RECONNECT_MAX_MS", "300000"), 10);
export const BRIDGE_DB_PATH = () =>
	optional("BRIDGE_DB_PATH", `${BRIDGE_DATA_DIR()}/bridge.sqlite`);
export const PORT = () => parseInt(optional("PORT", "3301"), 10);
export const ENABLE_GUILD_MEMBERS_INTENT = () =>
	process.env.ENABLE_GUILD_MEMBERS_INTENT !== "false";

export const Level = type(
	'"debug" | "info" | "warn" | "error" | undefined',
).pipe((v) => v ?? "info");
export type Level = typeof Level.infer;
export const LOG_LEVEL = (): Level => {
	const l = Level(process.env.LOG_LEVEL);
	return l instanceof type.errors ? "info" : l;
};
