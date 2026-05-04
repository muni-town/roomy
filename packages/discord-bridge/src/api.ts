import type { BridgeRepository } from "./db/repository.ts";
import { ATPROTO_BRIDGE_DID, PORT } from "./env.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("api");

export function startApi(
  repo: BridgeRepository,
  getAppId: () => string | undefined,
) {
  const server = Bun.serve({
    port: PORT,
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
      if (!appId) return jsonResponse({ error: "Discord bot still starting" }, 500);
      return jsonResponse({ discordAppId: appId, bridgeDid: ATPROTO_BRIDGE_DID });
    }

    case "/get-guild-id": {
      const spaceId = url.searchParams.get("spaceId");
      if (!spaceId) return jsonResponse({ error: "spaceId query parameter required" }, 400);
      const configs = repo.listAllBridgeConfigs();
      const match = configs.find((c) => c.spaceDid === spaceId);
      if (match) return jsonResponse({ guildId: match.guildId });
      return jsonResponse({ error: "Guild not found for provided space" }, 404);
    }

    case "/get-space-id": {
      const guildId = url.searchParams.get("guildId");
      if (!guildId) return jsonResponse({ error: "guildId query parameter required" }, 400);
      const configs = repo.listBridgeConfigsForGuild(guildId);
      if (configs.length > 0) return jsonResponse({ spaceIds: configs.map((c) => c.spaceDid) });
      return jsonResponse({ error: "Space not found for provided guild" }, 404);
    }

    case "/bridges": {
      const guildId = url.searchParams.get("guildId");
      const bridges = guildId
        ? repo.listBridgeConfigsForGuild(guildId)
        : repo.listAllBridgeConfigs();
      return jsonResponse({ bridges });
    }

    default:
      return jsonResponse({ error: "Not found" }, 404);
  }
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
