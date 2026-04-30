import { createLogger } from "./logger.ts";
import { BRIDGE_DATA_DIR, DISCORD_TOKEN } from "./env.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BridgeRepository } from "./db/repository.ts";
import { initRoomyClient } from "./roomy/client.ts";
import { SpaceManager } from "./roomy/space-manager.ts";
import { createBot, Intents } from "@discordeno/bot";
import { desiredProperties, type DiscordBot, type MessageProperties, type ChannelProperties } from "./discord/types.ts";
import { getProxyCacheBot } from "./discord/cache.ts";
import { ingestDiscordMessage } from "./services/message-ingestion.ts";
import {
  handleMessageUpdate,
  handleMessageDelete,
  handleReactionAdd,
  handleReactionRemove,
  handleThreadCreate,
} from "./services/stub-handlers.ts";

const log = createLogger("bridge");

async function main() {
  log.info("bridge starting");
  await mkdir(BRIDGE_DATA_DIR, { recursive: true });
  log.info(`data dir ready at ${BRIDGE_DATA_DIR}`);

  const dbPath = join(BRIDGE_DATA_DIR, "bridge.sqlite");
  const repo = BridgeRepository.open(dbPath);
  log.info(`sqlite store opened at ${dbPath}`);

  // Initialize Roomy client
  const roomyClient = await initRoomyClient();
  const spaceManager = new SpaceManager(roomyClient);

  // Start Discord gateway
  const bot = getProxyCacheBot(
    createBot({
      token: DISCORD_TOKEN,
      intents:
        Intents.MessageContent |
        Intents.Guilds |
        Intents.GuildMessages |
        Intents.GuildMessageReactions,
      desiredProperties,
      events: {
        ready(data) {
          log.info(
            `Discord bot connected — app ${data.applicationId}, ${data.guilds.length} guilds, shard ${data.shardId}`,
          );
        },

        async messageCreate(message: MessageProperties) {
          await ingestDiscordMessage(message, repo, spaceManager);
        },

        messageUpdate(message: MessageProperties) {
          handleMessageUpdate(message);
        },

        messageDelete(data) {
          handleMessageDelete(data.id, data.channelId, data.guildId);
        },

        reactionAdd(data) {
          handleReactionAdd(
            data.messageId,
            data.channelId,
            data.userId,
            data.emoji,
            data.guildId ?? 0n,
          );
        },

        reactionRemove(data) {
          handleReactionRemove(
            data.messageId,
            data.channelId,
            data.userId,
            data.emoji,
            data.guildId ?? 0n,
          );
        },

        threadCreate(channel) {
          handleThreadCreate(channel as ChannelProperties & { parentId: bigint });
        },
      },
    }),
  ) as DiscordBot;

  await bot.start();
  log.info("Discord gateway connected");

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);

    try {
      await spaceManager.disconnectAll();
    } catch (err) {
      log.error("Error disconnecting spaces", err);
    }

    repo.close();
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info("bridge running");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
