import type { BridgeRepository } from "./db/repository.ts";
import { ATPROTO_BRIDGE_DID, PORT } from "./env.ts";
import { createLogger } from "./logger.ts";
import { isBackfillRunning } from "./services/backfill.ts";

const log = createLogger("api");

export function startApi(
	repo: BridgeRepository,
	getAppId: () => string | undefined,
) {
	const server = Bun.serve({
		port: PORT(),
		async fetch(req) {
			const url = new URL(req.url);

			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders() });
			}

			let response: Response;
			try {
				response = route(url, repo, getAppId);
			} catch (err) {
				log.error("API error", err);
				response = jsonResponse({ error: "Internal server error" }, 500);
			}

			for (const [k, v] of Object.entries(corsHeaders())) {
				response.headers.set(k, v);
			}
			return response;
		},
	});

	log.info(`API listening on 0.0.0.0:${server.port}`);
	return server;
}

function route(
	url: URL,
	repo: BridgeRepository,
	getAppId: () => string | undefined,
): Response {
	switch (url.pathname) {
		case "/info": {
			const appId = getAppId();
			if (!appId)
				return jsonResponse({ error: "Discord bot still starting" }, 500);
			return jsonResponse({
				discordAppId: appId,
				bridgeDid: ATPROTO_BRIDGE_DID(),
			});
		}

		case "/get-guild-id": {
			const spaceId = url.searchParams.get("spaceId");
			if (!spaceId)
				return jsonResponse({ error: "spaceId query parameter required" }, 400);
			const configs = repo.listAllBridgeConfigs();
			const match = configs.find((c) => c.spaceDid === spaceId);
			if (match) return jsonResponse({ guildId: match.guildId });
			return jsonResponse({ error: "Guild not found for provided space" }, 404);
		}

		case "/get-space-id": {
			const guildId = url.searchParams.get("guildId");
			if (!guildId)
				return jsonResponse({ error: "guildId query parameter required" }, 400);
			const configs = repo.listBridgeConfigsForGuild(guildId);
			if (configs.length > 0)
				return jsonResponse({ spaceIds: configs.map((c) => c.spaceDid) });
			return jsonResponse({ error: "Space not found for provided guild" }, 404);
		}

		case "/bridges": {
			const guildId = url.searchParams.get("guildId");
			const bridges = guildId
				? repo.listBridgeConfigsForGuild(guildId)
				: repo.listAllBridgeConfigs();
			return jsonResponse({ bridges });
		}

		case "/backfill/progress": {
			const spaceDid = url.searchParams.get("spaceDid");
			const guildId = url.searchParams.get("guildId");
			const channels = buildBackfillProgressPayload(repo, {
				spaceDid: spaceDid ?? undefined,
				guildId: guildId ?? undefined,
			});
			return jsonResponse({ channels });
		}

		default:
			return jsonResponse({ error: "Not found" }, 404);
	}
}

/**
 * Serialize per-(channel, space) backfill progress for the REST endpoint.
 *
 * Honest-by-construction: Discord's history is unbounded and there is no
 * message-count API, so a "remaining / percent" figure cannot be computed
 * without walking the full history — the payload deliberately omits any
 * denominator. Per-channel state comes from the durable `backfill_progress`
 * rows (survive restarts); `running` reflects the in-process registry only,
 * so after a restart nothing is reported as running until the boot backfill
 * re-schedules it.
 */
export function buildBackfillProgressPayload(
	repo: BridgeRepository,
	scope?: { spaceDid?: string; guildId?: string },
): Array<{
	spaceDid: string;
	channelId: string;
	guildId: string | null;
	kind: "channel" | "thread" | null;
	channelName: string | null;
	phase: "phase1" | "phase2" | "complete";
	messagesSynced: number;
	messagesSkipped: number;
	cursor: string | null;
	/** Thread rows only: Discord id of the parent channel (panel nesting). */
	parentId: string | null;
	/** Recent-window size at the phase1→phase2 transition (panel phase-2 label). */
	windowSynced: number | null;
	/** Roomy room id this channel/thread maps to, for sidebar-order joins. */
	roomyId: string | null;
	running: boolean;
	updatedAt: number;
}> {
	const rows = repo
		.listBackfillProgress(scope?.spaceDid)
		.filter((p) => !scope?.guildId || p.guildId === scope.guildId);
	return rows.map((p) => ({
		spaceDid: p.spaceDid,
		channelId: p.channelId,
		guildId: p.guildId,
		kind: p.kind,
		channelName: p.channelName,
		phase: p.phase,
		messagesSynced: p.messagesSynced,
		messagesSkipped: p.messagesSkipped,
		cursor: repo.getChannelCursor(p.spaceDid, p.channelId)?.lastMessageId ?? null,
		parentId: p.parentId,
		windowSynced: p.windowSynced,
		roomyId: repo.getRoomyRoomId(p.spaceDid, p.channelId) ?? null,
		running: isBackfillRunning(p.spaceDid, p.channelId),
		updatedAt: p.updatedAt,
	}));
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	};
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
