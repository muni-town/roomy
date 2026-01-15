import { AutoRouter, cors, error, json } from "itty-router";
import { registeredBridges } from "./db.js";
import { createServerAdapter } from "@whatwg-node/server";
import { createServer } from "http";
import { PORT } from "./env.js";
import { botState } from "./discord/bot.js";
import { trace } from "@opentelemetry/api";
import { getRoomyClient, getBridgeDid } from "./roomy/client.js";
import { StreamDid, modules } from "@roomy/sdk";

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
          bridgeDid: getBridgeDid(),
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

    /**
     * Join a space as the bridge user.
     * POST /join-space
     * Body: { spaceId: string }
     * Returns: { bridgeDid: string, spaceId: string }
     */
    router.post("/join-space", async (request) => {
      return tracer.startActiveSpan("join-space", async (joinSpan) => {
        try {
          const body = await request.json();
          const spaceId = body?.spaceId;

          if (typeof spaceId !== "string") {
            joinSpan.setStatus({ code: 2, message: "spaceId required" });
            joinSpan.end();
            return error(400, "spaceId required in request body");
          }

          // Validate it looks like a stream DID
          let streamDid: StreamDid;
          try {
            streamDid = StreamDid.assert(spaceId);
          } catch {
            joinSpan.setStatus({ code: 2, message: "invalid spaceId" });
            joinSpan.end();
            return error(400, "Invalid spaceId - must be a valid stream DID");
          }

          const client = getRoomyClient();

          // Join the space
          console.log(`Bridge joining space: ${spaceId}`);
          await client.joinSpace(streamDid, modules.space);
          console.log(`Bridge successfully joined space: ${spaceId}`);

          joinSpan.setStatus({ code: 1 });
          joinSpan.end();

          return json({
            bridgeDid: getBridgeDid(),
            spaceId,
          });
        } catch (e) {
          console.error("Error joining space:", e);
          joinSpan.setStatus({
            code: 2,
            message: e instanceof Error ? e.message : "Unknown error",
          });
          joinSpan.end();
          return error(
            500,
            `Failed to join space: ${e instanceof Error ? e.message : "Unknown error"}`,
          );
        }
      });
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
