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
export const APPSERVER_WS_URL = () => required("APPSERVER_WS_URL");

export const STREAM_NSID = () =>
	optional("STREAM_NSID", "space.roomy.space.personal.dev");
export const STREAM_HANDLE_NSID = () =>
	optional("STREAM_HANDLE_NSID", "space.roomy.space.handle.dev");

export const BRIDGE_DATA_DIR = () => optional("BRIDGE_DATA_DIR", "./data");
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
