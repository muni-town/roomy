import { AutoRouter, cors, error, json } from "itty-router";
import { jazz } from "./jazz.js";
import { registeredBridges } from "./db.js";
import { createServerAdapter } from "@whatwg-node/server";
import { createServer } from "http";
import { PORT } from "./env.js";
import { botState } from "./discordBot.js";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("api");

export function startApi() {
  tracer.startActiveSpan("start", (span) => {
    // Create the API router
    const { preflight, corsify } = cors();
    const router = AutoRouter({
      before: [preflight],
      finally: [corsify],
    });

    router.get("/info", () => {
      if (botState.appId)
        return json({
          discordAppId: botState.appId,
          jazzAccountId: jazz.id,
        });
      return error(500, "Discord bot still starting");
    });

    router.get("/get-guild-id", async ({ query }) => {
      const spaceId = query.spaceId;
      if (typeof spaceId !== "string")
        return error(400, "spaceId query parameter required");
      const guildId = await registeredBridges.get_guildId(spaceId);
      if (guildId) return json({ guildId });
      return error(404, "Guild not found for provided space");
    });

    router.get("/get-space-id", async ({ query }) => {
      const guildId = query.guildId;
      if (typeof guildId !== "string")
        return error(400, "guildId query parameter required");
      const spaceId = await registeredBridges.get_spaceId(guildId);
      if (spaceId) return json({ spaceId });
      return error(404, "Space not found for provided guild");
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
