import { createLogger } from "./logger.ts";
import {
	BRIDGE_DATA_DIR,
	BRIDGE_DB_PATH,
	DISCORD_TOKEN,
	ENABLE_GUILD_MEMBERS_INTENT,
} from "./env.ts";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BridgeRepository } from "./db/repository.ts";
import { initRoomyClient } from "./roomy/client.ts";
import { SpaceManager } from "./roomy/space-manager.ts";
import { createBot, Intents } from "@discordeno/bot";
import {
	desiredProperties,
	type MessageProperties,
	type ChannelProperties,
	type InteractionProperties,
} from "./discord/types.ts";
import { getProxyCacheBot, type DiscordBotWithCache } from "./discord/cache.ts";
import { LiveDiscordDataSource } from "./discord/live-data-source.ts";
import { LiveRoomyGateway } from "./roomy/live-gateway.ts";
import {
	normalizeMessage,
	normalizeChannel,
	normalizeUser,
} from "./discord/normalizers.ts";
import { ingestDiscordMessage } from "./services/message-ingestion.ts";
import { runBackfill } from "./services/backfill.ts";
import {
	syncUserProfile,
	retryStaleProfileSyncs,
} from "./services/profile-sync.ts";
import {
	handleMessageEdit,
	handleMessageDelete,
} from "./services/message-edit-delete.ts";
import {
	handleReactionAdd,
	handleReactionRemove,
} from "./services/reaction-sync.ts";
import {
	handleChannelCreate,
	handleThreadCreate,
	handleRoomUpdate,
	handleRoomDelete,
} from "./services/room-sync.ts";
import {
	registerSlashCommands,
	handleInteractionCreate,
} from "./discord/slash-commands.ts";
import { startApi } from "./api.ts";

const log = createLogger("bridge");
let appId: string | undefined;

async function main() {
	log.info("bridge starting");
	await mkdir(BRIDGE_DATA_DIR(), { recursive: true });
	log.info(`data dir ready at ${BRIDGE_DATA_DIR()}`);

	await mkdir(dirname(BRIDGE_DB_PATH()), { recursive: true });
	const repo = BridgeRepository.open(BRIDGE_DB_PATH());
	log.info(`sqlite store opened at ${BRIDGE_DB_PATH()}`);

	log.info("starting api...");

	// Start HTTP API
	startApi(repo, () => appId);

	// Initialize Roomy client
	const roomyClient = await initRoomyClient();
	const spaceManager = new SpaceManager(roomyClient);
	const roomy = new LiveRoomyGateway(spaceManager);

	// Start Discord gateway
	// bot is assigned immediately after createBot; event handlers fire
	// asynchronously on gateway events, so the reference is always valid.
	let bot!: DiscordBotWithCache;

	bot = getProxyCacheBot(
		createBot({
			token: DISCORD_TOKEN(),
			desiredProperties: desiredProperties,
			intents:
				Intents.MessageContent |
				Intents.Guilds |
				Intents.GuildMessages |
				Intents.GuildMessageReactions |
				(ENABLE_GUILD_MEMBERS_INTENT() ? Intents.GuildMembers : 0),
			events: {
				ready(data) {
					appId = data.applicationId.toString();
					log.info(
						`Discord bot connected — app ${appId}, ${data.guilds.length} guilds, shard ${data.shardId}`,
					);
					registerSlashCommands(bot).catch((err) =>
						log.error("Slash command registration failed", err),
					);

					// Create adapters and run backfill
					const discord = new LiveDiscordDataSource(bot);
					runBackfill(discord, repo, roomy).catch((err) =>
						log.error("Backfill failed", err),
					);

					// Periodic profile sync retry: every 5 minutes, drain the
					// stale profile sync queue with exponential backoff.
					setInterval(
						async () => {
							try {
								await retryStaleProfileSyncs(repo, roomy);
							} catch (err) {
								log.error("Profile sync retry sweep failed", err);
							}
						},
						5 * 60 * 1000,
					);
				},

				async messageCreate(message: MessageProperties) {
					const discord = new LiveDiscordDataSource(bot);
					await ingestDiscordMessage(
						normalizeMessage(message),
						repo,
						roomy,
						undefined,
						undefined,
						(snowflake) => discord.resolveChannelName(snowflake),
					);
				},

				async messageUpdate(message: MessageProperties) {
					const discord = new LiveDiscordDataSource(bot);
					await handleMessageEdit(
						normalizeMessage(message),
						repo,
						roomy,
						(snowflake) => discord.resolveChannelName(snowflake),
					);
				},

				async messageDelete(data) {
					await handleMessageDelete(
						data.id,
						data.channelId,
						data.guildId,
						repo,
						roomy,
					);
				},

				reactionAdd(data) {
					handleReactionAdd(
						data.messageId,
						data.channelId,
						data.userId,
						data.emoji,
						data.guildId ?? 0n,
						repo,
						roomy,
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
						roomy,
					);
				},

				async channelCreate(channel: ChannelProperties) {
					await handleChannelCreate(normalizeChannel(channel), repo, roomy);
				},

				async channelUpdate(channel: ChannelProperties) {
					await handleRoomUpdate(normalizeChannel(channel), repo, roomy);
				},

				async channelDelete(channel: ChannelProperties) {
					await handleRoomDelete(normalizeChannel(channel), repo, roomy);
				},

				async threadCreate(channel: ChannelProperties) {
					await handleThreadCreate(normalizeChannel(channel), repo, roomy);
				},

				async threadUpdate(channel: ChannelProperties) {
					await handleRoomUpdate(normalizeChannel(channel), repo, roomy);
				},

				async threadDelete(channel: ChannelProperties) {
					await handleRoomDelete(normalizeChannel(channel), repo, roomy);
				},

				async interactionCreate(interaction: InteractionProperties) {
					await handleInteractionCreate(interaction, repo, spaceManager, bot);
				},

				async guildMemberAdd(
					member,
					user: {
						id: bigint;
						username: string;
						globalName?: string | null;
						discriminator?: string;
						avatar?: bigint | null;
					},
				) {
					if (!ENABLE_GUILD_MEMBERS_INTENT()) return;

					const guildIdStr = member.guildId?.toString();
					if (!guildIdStr) return;

					const configs = repo.listBridgeConfigsForGuild(guildIdStr);
					const targetSpaces = configs
						.filter(
							(c) =>
								c.mode === "full" ||
								repo.isAllowlisted(c.spaceDid, member.id.toString()),
						)
						.map((c) => c.spaceDid);

					if (targetSpaces.length === 0) return;

					const userData = normalizeUser(user);
					await syncUserProfile(userData, targetSpaces, repo, roomy);
				},
			},
		}),
	);

	await bot.start();
	log.info("Discord gateway connected");

	// Graceful shutdown
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info(`received ${signal}, shutting down`);

		try {
			await roomy.disconnectAll();
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
