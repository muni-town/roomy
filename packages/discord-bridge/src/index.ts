import { createLogger } from "./logger.ts";
import { BRIDGE_DATA_DIR, BRIDGE_DB_PATH, DISCORD_TOKEN } from "./env.ts";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BridgeRepository } from "./db/repository.ts";
import { initRoomyClient } from "./roomy/client.ts";
import { SpaceManager } from "./roomy/space-manager.ts";
import { createBot, Intents } from "@discordeno/bot";
import { desiredProperties, type DiscordBot, type MessageProperties, type ChannelProperties } from "./discord/types.ts";
import { getProxyCacheBot } from "./discord/cache.ts";
import { ingestDiscordMessage } from "./services/message-ingestion.ts";
import { runBackfill } from "./services/backfill.ts";
import {
  handleMessageEdit,
  handleMessageDelete,
} from "./services/message-edit-delete.ts";
import {
  handleReactionAdd,
  handleReactionRemove,
} from "./services/reaction-sync.ts";
import { handleThreadCreate } from "./services/thread-ingestion.ts";
import {
  registerSlashCommands,
  handleInteractionCreate,
} from "./discord/slash-commands.ts";
import type { InteractionProperties } from "./discord/types.ts";

const log = createLogger("bridge");
let backfillRunning = false;

async function main() {
  log.info("bridge starting");
  await mkdir(BRIDGE_DATA_DIR, { recursive: true });
  log.info(`data dir ready at ${BRIDGE_DATA_DIR}`);

  await mkdir(dirname(BRIDGE_DB_PATH), { recursive: true });
  const repo = BridgeRepository.open(BRIDGE_DB_PATH);
  log.info(`sqlite store opened at ${BRIDGE_DB_PATH}`);

  // Initialize Roomy client
  const roomyClient = await initRoomyClient();
  const spaceManager = new SpaceManager(roomyClient);

  // Start Discord gateway
  // bot is assigned immediately after createBot; event handlers fire
  // asynchronously on gateway events, so the reference is always valid.
  let bot!: DiscordBot;

  bot = getProxyCacheBot(
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
          registerSlashCommands(bot).catch((err) =>
            log.error("Slash command registration failed", err),
          );
          if (!backfillRunning) {
            backfillRunning = true;
            runBackfill(bot, repo, spaceManager)
              .catch((err) => log.error("Backfill failed", err))
              .finally(() => { backfillRunning = false; });
          }
        },

        async messageCreate(message: MessageProperties) {
          await ingestDiscordMessage(message, repo, spaceManager);
        },

        async messageUpdate(message: MessageProperties) {
          await handleMessageEdit(message, repo, spaceManager);
        },

        async messageDelete(data) {
          await handleMessageDelete(data.id, data.channelId, data.guildId, repo, spaceManager);
        },

        reactionAdd(data) {
          handleReactionAdd(
            data.messageId,
            data.channelId,
            data.userId,
            data.emoji,
            data.guildId ?? 0n,
            repo,
            spaceManager,
          );
        },

        reactionRemove(data) {
          handleReactionRemove(
            data.messageId,
            data.channelId,
            data.userId,
            data.emoji,
            data.guildId ?? 0n,
            repo,
            spaceManager,
          );
        },

        async threadCreate(channel) {
          await handleThreadCreate(channel as ChannelProperties, repo, spaceManager);
        },

        async interactionCreate(interaction: InteractionProperties) {
          await handleInteractionCreate(interaction, repo, spaceManager, bot);
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
