import { AutoRouter, cors, error, json } from "itty-router";
import { bridgeConfigs } from "./repositories/LevelDBBridgeRepository.js";
import { createServerAdapter } from "@whatwg-node/server";
import { createServer } from "http";
import { PORT } from "./env.js";
import { trace } from "@opentelemetry/api";
import { BridgeOrchestrator } from "./BridgeOrchestrator.js";

const tracer = trace.getTracer("api");

export function startApi(bridgeOrchestrator: BridgeOrchestrator) {
  tracer.startActiveSpan("start", (span) => {
    // Create the API router
    const { preflight, corsify } = cors();
    const router = AutoRouter({
      before: [preflight],
      finally: [corsify],
    });

    router.get("/info", () => {
      if (bridgeOrchestrator.appId)
        return json({
          discordAppId: bridgeOrchestrator.appId,
          bridgeDid: bridgeOrchestrator.getBridgeDid(),
        });
      return error(500, "Discord bot still starting");
    });

    router.get("/get-guild-id", async ({ query }) => {
      const spaceId = query.spaceId;
      if (typeof spaceId !== "string")
        return error(400, "spaceId query parameter required");
      const configs = await bridgeConfigs.list();
      const match = configs.find((c) => c.spaceId === spaceId);
      if (match) return json({ guildId: match.guildId });
      return error(404, "Guild not found for provided space");
    });

    router.get("/get-space-id", async ({ query }) => {
      const guildId = query.guildId;
      if (typeof guildId !== "string")
        return error(400, "guildId query parameter required");
      const configs = await bridgeConfigs.getBridgesForGuild(guildId);
      if (configs.length > 0)
        return json({ spaceIds: configs.map((c) => c.spaceId) });
      return error(404, "Space not found for provided guild");
    });

    router.get("/bridges", async ({ query }) => {
      const guildId = query.guildId;
      if (typeof guildId === "string") {
        const configs = await bridgeConfigs.getBridgesForGuild(guildId);
        return json({ bridges: configs });
      }
      // No guildId filter — return all
      const configs = await bridgeConfigs.list();
      return json({ bridges: configs });
    });

    // Start the API server
    const ittyServer = createServerAdapter(router.fetch);
    const httpServer = createServer(ittyServer);
    httpServer.listen(PORT);

    span.addEvent("API listening", { port: PORT });
    span.end();
    console.log(`API listening on 0.0.0.0:${PORT}`);
  });
}
