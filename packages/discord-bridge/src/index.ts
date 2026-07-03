import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createBot, Intents } from "@discordeno/bot";
import { startApi } from "./api.ts";
import { BridgeRepository } from "./db/repository.ts";
import { type DiscordBotWithCache, getProxyCacheBot } from "./discord/cache.ts";
import { LiveDiscordDataSource } from "./discord/live-data-source.ts";
import { LiveDiscordSender } from "./discord/live-sender.ts";
import { LiveWebhookManager } from "./discord/live-webhook-manager.ts";
import {
	normalizeChannel,
	normalizeMessage,
	normalizeUser,
} from "./discord/normalizers.ts";
import {
	handleInteractionCreate,
	registerSlashCommands,
} from "./discord/slash-commands.ts";
import {
	type ChannelProperties,
	desiredProperties,
	type InteractionProperties,
	type MessageProperties,
} from "./discord/types.ts";
import {
	APPSERVER_DID,
	APPSERVER_URL,
	APPSERVER_WS_URL,
	BRIDGE_DATA_DIR,
	BRIDGE_DB_PATH,
	DISCORD_TOKEN,
	ENABLE_GUILD_MEMBERS_INTENT,
} from "./env.ts";
import { createLogger } from "./logger.ts";
import { initRoomyClient } from "./roomy/client.ts";
import { LiveRoomyGateway } from "./roomy/live-gateway.ts";
import { LiveProfileResolver } from "./roomy/live-profile-resolver.ts";
import { SpaceManager } from "./roomy/space-manager.ts";
import { runBackfill } from "./services/backfill.ts";
import {
	handleMessageDelete,
	handleMessageEdit,
} from "./services/message-edit-delete.ts";
import { ingestDiscordMessage } from "./services/message-ingestion.ts";
import {
	retryStaleProfileSyncs,
	syncUserProfile,
} from "./services/profile-sync.ts";
import {
	handleReactionAdd,
	handleReactionRemove,
} from "./services/reaction-sync.ts";
import {
	handleChannelCreate,
	handleRoomDelete,
	handleRoomUpdate,
	handleThreadCreate,
} from "./services/room-sync.ts";
import { RoomyEventRouter } from "./services/roomy-event-router.ts";

const log = createLogger("bridge");
let appId: string | undefined;
/** Deferred router — resolved when the `ready` handler fires. All event
 *  handlers `await routerReady` before using the router. Since Discord
 *  guarantees `ready` fires before any other gateway event, the promise
 *  is always already resolved by the time it's awaited. */
let routerResolve!: (router: RoomyEventRouter) => void;
const routerReady = new Promise<RoomyEventRouter>((resolve) => {
	routerResolve = resolve;
});

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
	const spaceManager = new SpaceManager(roomyClient, APPSERVER_URL(), APPSERVER_DID());
	const roomy = new LiveRoomyGateway(spaceManager, repo, spaceManager.xrpc, APPSERVER_WS_URL());

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

					// Start Roomy→Discord event router
					const discordSender = new LiveDiscordSender(bot);
					const webhookManager = new LiveWebhookManager(bot, repo);
					const profileResolver = new LiveProfileResolver(roomyClient);
					const router = new RoomyEventRouter(
						roomy,
						discordSender,
						webhookManager,
						profileResolver,
						repo,
					);
					router
						.start()
						.catch((err) =>
							log.error("Roomy event router failed to start", err),
						);
					routerResolve(router);

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
					// Skip messages authored by our own bot (e.g. forwarded
					// messages created by forwardMessage). These are not webhook
					// messages so the isOurWebhook check won't catch them, and
					// the dedup mapping may not be registered yet due to the
					// REST/gateway race.
					if (appId && message.author.id === BigInt(appId)) {
						return;
					}
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
						bot.id,
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
					log.debug(
						"Waiting for RoomyEventRouter to be ready (routerReady promise)...",
					);
					const router = await routerReady;
					log.debug("RoomyEventRouter ready, handling interaction");
					await handleInteractionCreate(
						interaction,
						repo,
						spaceManager,
						bot,
						router,
					);
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
