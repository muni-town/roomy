import {
	ApplicationCommandOptionTypes,
	ButtonStyles,
	ChannelTypes,
	type CreateApplicationCommand,
	DiscordApplicationIntegrationType,
	DiscordInteractionContextType,
	InteractionTypes,
	type MessageComponent,
	MessageComponentTypes,
	MessageFlags,
} from "@discordeno/bot";

import { StreamDid } from "@roomy-space/sdk";
import type { BridgeConfig, BridgeRepository } from "../db/repository.ts";
import type { DiscordBotWithCache } from "../discord/cache.ts";
import { LiveDiscordDataSource } from "../discord/live-data-source.ts";
import { createLogger } from "../logger.ts";
import { LiveRoomyGateway } from "../roomy/live-gateway.ts";
import type { SpaceManager } from "../roomy/space-manager.ts";
import { backfillSingleChannel, runBackfill } from "../services/backfill.ts";
import type { DiscordBot, InteractionProperties } from "./types.ts";
import { CHANNEL_TYPES, MESSAGE_CHANNEL_TYPES } from "./types.ts";

const log = createLogger("slash");

// ─── Minimal types for Discordeno interaction sub-structures ─────────

interface ComponentInteractionData {
	customId: string;
	values?: string[];
	componentType?: number;
}

/** Access a split custom-id part that is guaranteed by construction. */
function part(parts: string[], index: number): string {
	const p = parts[index];
	if (!p) throw new Error(`Invalid custom ID: missing part ${index}`);
	return p;
}

/** Narrow interaction.data to a component interaction (has customId). */
function hasCustomId(data: unknown): data is ComponentInteractionData {
	return typeof data === "object" && data !== null && "customId" in data;
}

/** Type guard: an option object with name + value. */
function isNamedOption(opt: unknown): opt is { name: unknown; value: unknown } {
	return (
		typeof opt === "object" && opt !== null && "name" in opt && "value" in opt
	);
}

/** Find a subcommand option's value by name (type-safe array walk). */
function getOptionValue(options: unknown, name: string): unknown {
	if (!Array.isArray(options)) return undefined;
	for (const opt of options) {
		if (isNamedOption(opt) && opt.name === name) return opt.value;
	}
	return undefined;
}

/** Typed helper: get a string option value or undefined. */
function getStringOption(options: unknown, name: string): string | undefined {
	const val = getOptionValue(options, name);
	return typeof val === "string" ? val : undefined;
}

/** Create adapters from live bot + space manager for service calls. */
function createAdapters(bot: DiscordBot, spaceManager: SpaceManager) {
	return {
		discord: new LiveDiscordDataSource(bot),
		roomy: new LiveRoomyGateway(spaceManager),
	};
}

// ─── Channel selection pagination state ───────────────────────────────
// Key: `${guildId}:${userId}:${spaceDid}`
interface PageState {
	spaceDid: string;
	/** All message-capable channels in the guild, sorted alphabetically */
	channels: Array<{ id: string; name: string }>;
	/** Currently visible page (0-indexed) */
	page: number;
	/** Total number of pages */
	totalPages: number;
	/** Selections per page: Map<pageIndex, Set<channelId>> */
	selections: Map<number, Set<string>>;
}

const PAGE_SIZE = 25;
const pageStates = new Map<string, PageState>();

function getOrCreatePageState(
	bot: DiscordBotWithCache,
	guildId: string,
	userId: string,
	spaceDid: string,
): PageState {
	const key = `${guildId}:${userId}:${spaceDid}`;
	const existing = pageStates.get(key);
	if (existing) return existing;

	const guild = bot.cache.guilds.memory.get(BigInt(guildId));
	const allChannels: Array<{ id: string; name: string }> = [];
	if (guild?.channels) {
		for (const [id, ch] of guild.channels) {
			if (CHANNEL_TYPES.has(ch.type)) {
				allChannels.push({ id: id.toString(), name: ch.name ?? `#${id}` });
			}
		}
	}
	allChannels.sort((a, b) => a.name.localeCompare(b.name));

	const totalPages = Math.max(1, Math.ceil(allChannels.length / PAGE_SIZE));
	const state: PageState = {
		spaceDid,
		channels: allChannels,
		page: 0,
		totalPages,
		selections: new Map(),
	};
	pageStates.set(key, state);
	return state;
}

function buildChannelPageComponents(
	state: PageState,
	guildId: string,
	userId: string,
	spaceDid: string,
) {
	const { channels, page, totalPages, selections } = state;
	const start = page * PAGE_SIZE;
	const pageChannels = channels.slice(start, start + PAGE_SIZE);

	const options = pageChannels.map((ch) => ({
		label: `#${ch.name}`,
		value: ch.id,
		default: selections.get(page)?.has(ch.id) ?? false,
	}));

	const components: MessageComponent[] = [];

	if (options.length > 0) {
		components.push({
			type: MessageComponentTypes.ActionRow,
			components: [
				{
					type: MessageComponentTypes.SelectMenu,
					customId: `roomy|channel-page|${guildId}|${userId}|${spaceDid}|${page}`,
					placeholder: `Select channels (page ${page + 1}/${totalPages})`,
					minValues: 0,
					maxValues: options.length,
					options,
				},
			],
		});
	}

	components.push({
		type: MessageComponentTypes.ActionRow,
		components: [
			page > 0
				? {
						type: MessageComponentTypes.Button,
						style: ButtonStyles.Secondary,
						label: "◀ Previous",
						customId: `roomy|channel-nav|${guildId}|${userId}|${spaceDid}|prev`,
					}
				: {
						type: MessageComponentTypes.Button,
						style: ButtonStyles.Secondary,
						label: `Next ▶ (page ${page + 1}/${totalPages})`,
						customId: `roomy|channel-nav|${guildId}|${userId}|${spaceDid}|next`,
					},
			{
				type: MessageComponentTypes.Button,
				style: ButtonStyles.Success,
				label: "✅ Confirm Selection",
				customId: `roomy|channel-nav|${guildId}|${userId}|${spaceDid}|confirm`,
			},

			{
				type: MessageComponentTypes.Button,
				style: ButtonStyles.Danger,
				label: "Cancel",
				customId: `roomy|channel-nav|${guildId}|${userId}|${spaceDid}|cancel`,
			},
		],
	});

	return components;
}

function totalSelectedCount(state: PageState): number {
	let count = 0;
	for (const sel of state.selections.values()) {
		count += sel.size;
	}
	return count;
}

// ─── Command definitions ──────────────────────────────────────────────

export const slashCommands = [
	{
		name: "connect-roomy-space",
		description: "Connect a Roomy space to this Discord guild.",
		contexts: [DiscordInteractionContextType.Guild],
		integrationTypes: [DiscordApplicationIntegrationType.GuildInstall],
		defaultMemberPermissions: ["ADMINISTRATOR"],
		options: [
			{
				name: "space-id",
				description: "The DID of the Roomy space to connect.",
				type: ApplicationCommandOptionTypes.String,
				required: true,
			},
		],
	},
	{
		name: "disconnect-roomy-space",
		description: "Disconnect a bridged Roomy space.",
		contexts: [DiscordInteractionContextType.Guild],
		integrationTypes: [DiscordApplicationIntegrationType.GuildInstall],
		defaultMemberPermissions: ["ADMINISTRATOR"],
		options: [
			{
				name: "space-id",
				description:
					"The specific space to disconnect (optional if only one bridge).",
				type: ApplicationCommandOptionTypes.String,
				required: false,
			},
		],
	},
	{
		name: "roomy-status",
		description: "Get the current status of the Roomy Discord bridge.",
		contexts: [DiscordInteractionContextType.Guild],
		integrationTypes: [DiscordApplicationIntegrationType.GuildInstall],
		defaultMemberPermissions: ["ADMINISTRATOR"],
	},
	{
		name: "roomy-bridge-channel",
		description: "Manage which Discord channels are bridged (subset mode).",
		contexts: [DiscordInteractionContextType.Guild],
		integrationTypes: [DiscordApplicationIntegrationType.GuildInstall],
		defaultMemberPermissions: ["ADMINISTRATOR"],
		options: [
			{
				name: "add",
				description: "Add a channel to the bridge allowlist.",
				type: ApplicationCommandOptionTypes.SubCommand,
				options: [
					{
						name: "channel",
						description: "The channel to bridge.",
						type: ApplicationCommandOptionTypes.Channel,
						channelTypes: [
							ChannelTypes.GuildText,
							ChannelTypes.GuildAnnouncement,
						],
						required: true,
					},
					{
						name: "space-id",
						description: "The space DID (if multiple bridges).",
						type: ApplicationCommandOptionTypes.String,
						required: false,
					},
				],
			},
			{
				name: "remove",
				description: "Remove a channel from the bridge allowlist.",
				type: ApplicationCommandOptionTypes.SubCommand,
				options: [
					{
						name: "channel",
						description: "The channel to remove.",
						type: ApplicationCommandOptionTypes.Channel,
						channelTypes: [
							ChannelTypes.GuildText,
							ChannelTypes.GuildAnnouncement,
						],
						required: true,
					},
					{
						name: "space-id",
						description: "The space DID (if multiple bridges).",
						type: ApplicationCommandOptionTypes.String,
						required: false,
					},
				],
			},
			{
				name: "list",
				description: "List channels in the bridge allowlist.",
				type: ApplicationCommandOptionTypes.SubCommand,
				options: [
					{
						name: "space-id",
						description: "The space DID (if multiple bridges).",
						type: ApplicationCommandOptionTypes.String,
						required: false,
					},
				],
			},
		],
	},
	{
		name: "roomy-backfill",
		description:
			"Re-backfill from Discord history. Resets cursors so gaps are caught; dedup prevents duplicates.",
		contexts: [DiscordInteractionContextType.Guild],
		integrationTypes: [DiscordApplicationIntegrationType.GuildInstall],
		defaultMemberPermissions: ["ADMINISTRATOR"],
		options: [
			{
				name: "channel",
				description:
					"A specific channel to re-backfill. Omit to re-backfill all bridged channels.",
				type: ApplicationCommandOptionTypes.Channel,
				channelTypes: [ChannelTypes.GuildText, ChannelTypes.GuildAnnouncement],
				required: false,
			},
		],
	},
] satisfies CreateApplicationCommand[];

// ─── Registration ─────────────────────────────────────────────────────

export async function registerSlashCommands(
	bot: DiscordBotWithCache,
): Promise<void> {
	await bot.helpers.upsertGlobalApplicationCommands(slashCommands);
	log.info(`Registered ${slashCommands.length} slash commands`);
}

// ─── Interaction age helpers ──────────────────────────────────────────

const DISCORD_EPOCH = 1420070400000n;

function getInteractionAgeMs(interactionId: bigint): number {
	const timestamp = Number((interactionId >> 22n) + DISCORD_EPOCH);
	return Date.now() - timestamp;
}

/** Type guard: error has a `.cause` property. */
function hasCause(error: unknown): error is { cause: unknown } {
	return typeof error === "object" && error !== null && "cause" in error;
}

/**
 * Narrow an unknown cause to an object with a `body` property directly
 * (avoids inline casts).
 */
function hasBodyField(cause: unknown): cause is { body: string } {
	return (
		typeof cause === "object" &&
		cause !== null &&
		"body" in cause &&
		typeof cause.body === "string"
	);
}

/** Type guard: error has a cause with a `.body` property (Discordeno API error shape). */
function hasCauseBody(error: unknown): error is { cause: { body: string } } {
	if (!hasCause(error)) return false;
	return hasBodyField(error.cause);
}

function isInteractionAlreadyHandled(error: unknown): boolean {
	if (!hasCauseBody(error)) return false;
	const errorBody = error.cause.body;
	try {
		const parsed = JSON.parse(errorBody);
		return parsed?.code === 40060 || parsed?.code === 10062;
	} catch {
		return (
			errorBody.includes("already been acknowledged") ||
			errorBody.includes("Unknown Interaction")
		);
	}
}

async function safeDefer(
	interaction: InteractionProperties,
	ephemeral: boolean,
): Promise<boolean> {
	const ageMs = getInteractionAgeMs(BigInt(interaction.id));
	if (ageMs > 2500) {
		log.debug(`Skipping stale interaction (${ageMs}ms old)`);
		return false;
	}
	try {
		await interaction.defer(ephemeral);
		return true;
	} catch (e: unknown) {
		if (isInteractionAlreadyHandled(e)) return false;
		throw e;
	}
}

// ─── Main handler ─────────────────────────────────────────────────────

export async function handleInteractionCreate(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	spaceManager: SpaceManager,
	bot: DiscordBotWithCache,
): Promise<void> {
	if (!interaction.guildId) return;
	const guildId = interaction.guildId.toString();

	if (interaction.type === InteractionTypes.ApplicationCommand) {
		const commandName = interaction.data?.name;
		if (commandName === "roomy-status") {
			await handleStatus(interaction, repo, guildId);
		} else if (commandName === "connect-roomy-space") {
			await handleConnect(interaction, repo, guildId);
		} else if (commandName === "disconnect-roomy-space") {
			await handleDisconnect(interaction, repo, spaceManager, guildId);
		} else if (commandName === "roomy-bridge-channel") {
			await handleBridgeChannel(interaction, repo, spaceManager, bot, guildId);
		} else if (commandName === "roomy-backfill") {
			await handleBackfill(interaction, repo, spaceManager, bot, guildId);
		}
		return;
	}

	if (interaction.type === InteractionTypes.MessageComponent) {
		await handleComponentInteraction(
			interaction,
			repo,
			spaceManager,
			bot,
			guildId,
		);
		return;
	}
}

async function handleComponentInteraction(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	spaceManager: SpaceManager,
	bot: DiscordBotWithCache,
	guildId: string,
): Promise<void> {
	const data = interaction.data;
	if (!hasCustomId(data)) return;
	const customId = data.customId;
	if (!customId.startsWith("roomy|")) return;

	const parts = customId.split("|");
	const action = parts[1];

	try {
		if (action === "bridge-mode") {
			await handleBridgeModeButton(
				interaction,
				repo,
				spaceManager,
				bot,
				guildId,
				parts,
			);
		} else if (action === "channel-select") {
			await handleChannelSelect(
				interaction,
				repo,
				spaceManager,
				bot,
				guildId,
				parts,
			);
		} else if (action === "channel-page") {
			await handleChannelPageSelect(
				interaction,
				repo,
				spaceManager,
				bot,
				guildId,
				parts,
			);
		} else if (action === "channel-nav") {
			await handleChannelNav(
				interaction,
				repo,
				spaceManager,
				bot,
				guildId,
				parts,
			);
		}
	} catch (e) {
		log.error(`Error handling component interaction ${customId}`, e);
		try {
			await interaction.respond({
				flags: MessageFlags.Ephemeral,
				content: "An error occurred. Please try again.",
			});
		} catch {}
	}
}

// ─── /roomy-status ────────────────────────────────────────────────────

async function handleStatus(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	guildId: string,
): Promise<void> {
	if (!(await safeDefer(interaction, true))) return;

	try {
		const configs = repo.listBridgeConfigsForGuild(guildId);
		if (configs.length === 0) {
			await interaction.edit({
				content: "The Discord bridge is not connected to any Roomy spaces.",
			});
			return;
		}

		const lines = configs.map((cfg) => `- \`${cfg.spaceDid}\` (${cfg.mode})`);
		await interaction.edit({
			content: `**Connected bridges (${configs.length}):**\n${lines.join("\n")}`,
		});
	} catch (e) {
		log.error("Error handling roomy-status", e);
		try {
			await interaction.edit({
				content: "An error occurred while checking status.",
			});
		} catch {}
	}
}

// ─── /connect-roomy-space ─────────────────────────────────────────────

async function handleConnect(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	guildId: string,
): Promise<void> {
	if (!(await safeDefer(interaction, true))) return;

	try {
		const spaceIdOption = getOptionValue(interaction.data?.options, "space-id");

		if (typeof spaceIdOption !== "string") {
			await interaction.edit({ content: "Please provide a valid space ID." });
			return;
		}

		let spaceDid: string;
		try {
			spaceDid = StreamDid.assert(spaceIdOption);
		} catch {
			await interaction.edit({
				content: "Invalid space ID. Please provide a valid stream DID.",
			});
			return;
		}

		const existing = repo.getBridgeConfig(guildId, spaceDid);
		if (existing) {
			await interaction.edit({
				content: `This space is already bridged to this guild. Use \`/roomy-status\` to see connected spaces.`,
			});
			return;
		}

		const existingForGuild = repo.listBridgeConfigsForGuild(guildId);
		if (existingForGuild.some((c) => c.mode === "full")) {
			await interaction.edit({
				content:
					"This guild already has a full bridge. Disconnect it first with `/disconnect-roomy-space`, or pick subset mode.",
			});
			return;
		}

		await interaction.edit({
			content: "How would you like to bridge this space?",
			components: [
				{
					type: MessageComponentTypes.ActionRow,
					components: [
						{
							type: MessageComponentTypes.Button,
							style: ButtonStyles.Primary,
							label: "Bridge All Channels",
							customId: `roomy|bridge-mode|${guildId}|${spaceDid}|full`,
						},
						{
							type: MessageComponentTypes.Button,
							style: ButtonStyles.Secondary,
							label: "Select Specific Channels",
							customId: `roomy|bridge-mode|${guildId}|${spaceDid}|subset`,
						},
					],
				},
			],
		});
	} catch (e) {
		log.error("Error handling connect-roomy-space", e);
		try {
			await interaction.edit({
				content: "An error occurred while connecting the space.",
			});
		} catch {}
	}
}

// customId: roomy|bridge-mode|<guildId>|<spaceDid>|full|subset
async function handleBridgeModeButton(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	spaceManager: SpaceManager,
	bot: DiscordBotWithCache,
	guildId: string,
	parts: string[],
): Promise<void> {
	if (!(await safeDefer(interaction, true))) return;

	const mode = part(parts, 4);
	const spaceDid = part(parts, 3);

	if (mode === "full") {
		try {
			await spaceManager.getOrConnect(spaceDid);
		} catch (e) {
			log.error("Failed to connect to space", e);
			await interaction.edit({
				content:
					"Could not connect to that space. Make sure the bridge has access.",
				components: [],
			});
			return;
		}

		repo.upsertBridgeConfig(guildId, spaceDid, "full");
		log.info(`Connected space ${spaceDid} to guild ${guildId} in full mode`);

		await interaction.edit({
			content: `Roomy space \`${spaceDid}\` connected in **full** mode! Starting sync...`,
			components: [],
		});

		runBackfill(
			createAdapters(bot, spaceManager).discord,
			repo,
			createAdapters(bot, spaceManager).roomy,
		).catch((err) => {
			log.error(`Initial backfill failed for space ${spaceDid}`, err);
		});
		return;
	}

	const userId =
		interaction.member?.id?.toString() ?? interaction.user?.id?.toString();
	if (!userId) {
		await interaction.edit({
			content: "Could not determine user. Please try again.",
			components: [],
		});
		return;
	}

	const state = getOrCreatePageState(bot, guildId, userId, spaceDid);
	if (state.channels.length === 0) {
		await interaction.edit({
			content:
				"No text channels found in this guild. Make sure the bridge has access to at least one channel.",
			components: [],
		});
		return;
	}

	const components = buildChannelPageComponents(
		state,
		guildId,
		userId,
		spaceDid,
	);
	const selectedSoFar = totalSelectedCount(state);
	const summary =
		selectedSoFar > 0
			? `\n\n**${selectedSoFar} channel(s) selected so far.**`
			: "";

	await interaction.edit({
		content: `Select channels to bridge — page **${state.page + 1}/${state.totalPages}** (${state.channels.length} total text channels):${summary}`,
		components,
	});
}

// customId: roomy|channel-page|<guildId>|<userId>|<spaceDid>|<pageNum>
async function handleChannelPageSelect(
	interaction: InteractionProperties,
	_repo: BridgeRepository,
	_spaceManager: SpaceManager,
	_bot: DiscordBotWithCache,
	guildId: string,
	parts: string[],
): Promise<void> {
	if (!(await safeDefer(interaction, true))) return;

	const userId = part(parts, 3);
	const spaceDid = part(parts, 4);
	const pageStr = part(parts, 5);
	const page = parseInt(pageStr, 10);

	const key = `${guildId}:${userId}:${spaceDid}`;
	const state = pageStates.get(key);
	if (!state) {
		await interaction.edit({
			content:
				"Session expired. Please start again with `/connect-roomy-space`.",
			components: [],
		});
		return;
	}

	const selections: string[] = hasCustomId(interaction.data)
		? (interaction.data.values ?? [])
		: [];
	state.selections.set(page, new Set(selections));

	const selectedSoFar = totalSelectedCount(state);
	const components = buildChannelPageComponents(
		state,
		guildId,
		userId,
		spaceDid,
	);

	await interaction.edit({
		content: `Select channels to bridge — page **${state.page + 1}/${state.totalPages}** (${state.channels.length} total text channels):\n\n**${selectedSoFar} channel(s) selected so far.**`,
		components,
	});
}

async function handleChannelNav(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	spaceManager: SpaceManager,
	bot: DiscordBotWithCache,
	guildId: string,
	parts: string[],
): Promise<void> {
	if (!(await safeDefer(interaction, true))) return;

	const userId = part(parts, 3);
	const spaceDid = part(parts, 4);
	const navAction = part(parts, 5);

	const key = `${guildId}:${userId}:${spaceDid}`;
	const state = pageStates.get(key);
	if (!state) {
		await interaction.edit({
			content:
				"Session expired. Please start again with `/connect-roomy-space`.",
			components: [],
		});
		return;
	}

	if (navAction === "prev") {
		state.page = Math.max(0, state.page - 1);
		const components = buildChannelPageComponents(
			state,
			guildId,
			userId,
			spaceDid,
		);
		const selectedSoFar = totalSelectedCount(state);
		await interaction.edit({
			content: `Select channels to bridge — page **${state.page + 1}/${state.totalPages}** (${state.channels.length} total text channels):\n\n**${selectedSoFar} channel(s) selected so far.**`,
			components,
		});
		return;
	}

	if (navAction === "next") {
		state.page = Math.min(state.totalPages - 1, state.page + 1);
		const components = buildChannelPageComponents(
			state,
			guildId,
			userId,
			spaceDid,
		);
		const selectedSoFar = totalSelectedCount(state);
		await interaction.edit({
			content: `Select channels to bridge — page **${state.page + 1}/${state.totalPages}** (${state.channels.length} total text channels):\n\n**${selectedSoFar} channel(s) selected so far.**`,
			components,
		});
		return;
	}

	if (navAction === "cancel") {
		pageStates.delete(key);
		await interaction.edit({
			content:
				"Channel selection cancelled. Use `/connect-roomy-space` to try again.",
			components: [],
		});
		return;
	}

	if (navAction === "confirm") {
		const selectedChannels: string[] = [];
		for (const sel of state.selections.values()) {
			for (const chId of sel) {
				selectedChannels.push(chId);
			}
		}

		if (selectedChannels.length === 0) {
			await interaction.edit({
				content:
					"No channels selected. Please go back and select at least one channel, or Cancel.",
				components: [],
			});
			return;
		}

		try {
			await spaceManager.getOrConnect(spaceDid);
		} catch (e) {
			log.error("Failed to connect to space", e);
			await interaction.edit({
				content:
					"Could not connect to that space. Make sure the bridge has access.",
				components: [],
			});
			return;
		}

		repo.upsertBridgeConfig(guildId, spaceDid, "subset");
		for (const channelId of selectedChannels) {
			repo.addToAllowlist(spaceDid, channelId, guildId);
		}
		log.info(
			`Connected space ${spaceDid} to guild ${guildId} in subset mode with ${selectedChannels.length} channels`,
		);

		pageStates.delete(key);

		await interaction.edit({
			content: `Roomy space \`${spaceDid}\` connected in **subset** mode with ${selectedChannels.length} channel(s). Starting sync...`,
			components: [],
		});

		runBackfill(
			createAdapters(bot, spaceManager).discord,
			repo,
			createAdapters(bot, spaceManager).roomy,
		).catch((err) => {
			log.error(`Initial backfill failed for space ${spaceDid}`, err);
		});
		return;
	}
}

// Deprecated — kept for compatibility with old component interactions
async function handleChannelSelect(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	spaceManager: SpaceManager,
	bot: DiscordBotWithCache,
	guildId: string,
	parts: string[],
): Promise<void> {
	if (!(await safeDefer(interaction, true))) return;

	const spaceDid = part(parts, 3);
	const selectedChannels: string[] = hasCustomId(interaction.data)
		? (interaction.data.values ?? [])
		: [];

	if (selectedChannels.length === 0) {
		await interaction.edit({
			content: "No channels selected. Please try again.",
			components: [],
		});
		return;
	}

	try {
		await spaceManager.getOrConnect(spaceDid);
	} catch (e) {
		log.error("Failed to connect to space", e);
		await interaction.edit({
			content:
				"Could not connect to that space. Make sure the bridge has access.",
			components: [],
		});
		return;
	}

	repo.upsertBridgeConfig(guildId, spaceDid, "subset");
	for (const channelId of selectedChannels) {
		repo.addToAllowlist(spaceDid, channelId, guildId);
	}
	log.info(
		`Connected space ${spaceDid} to guild ${guildId} in subset mode with ${selectedChannels.length} channels`,
	);

	await interaction.edit({
		content: `Roomy space \`${spaceDid}\` connected in **subset** mode with ${selectedChannels.length} channel(s). Starting sync...`,
		components: [],
	});

	runBackfill(
		createAdapters(bot, spaceManager).discord,
		repo,
		createAdapters(bot, spaceManager).roomy,
	).catch((err) => {
		log.error(`Initial backfill failed for space ${spaceDid}`, err);
	});
}

// ─── /disconnect-roomy-space ──────────────────────────────────────────

async function handleDisconnect(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	_spaceManager: SpaceManager,
	guildId: string,
): Promise<void> {
	if (!(await safeDefer(interaction, true))) return;

	try {
		const configs = repo.listBridgeConfigsForGuild(guildId);
		if (configs.length === 0) {
			await interaction.edit({
				content: "There are no Roomy spaces connected to disconnect.",
			});
			return;
		}

		const spaceIdOption = getStringOption(
			interaction.data?.options,
			"space-id",
		);

		let targetConfig: BridgeConfig | undefined;
		if (spaceIdOption) {
			targetConfig = configs.find((c) => c.spaceDid === spaceIdOption);
			if (!targetConfig) {
				await interaction.edit({
					content: `No bridge found for space \`${spaceIdOption}\` in this guild.`,
				});
				return;
			}
		} else if (configs.length === 1) {
			targetConfig = configs[0];
		} else {
			const spaceList = configs.map((c) => `- \`${c.spaceDid}\``).join("\n");
			await interaction.edit({
				content: `Multiple spaces are connected. Specify which one:\n${spaceList}\n\nUse \`/disconnect-roomy-space space-id: <did>\`.`,
			});
			return;
		}

		if (!targetConfig) {
			await interaction.edit({
				content: "Internal error: no target config at disconnect.",
			});
			return;
		}

		repo.removeBridgeConfig(guildId, targetConfig.spaceDid);
		log.info(
			`Disconnected space ${targetConfig.spaceDid} from guild ${guildId}`,
		);

		await interaction.edit({
			content: `Successfully disconnected space \`${targetConfig.spaceDid}\`.`,
		});
	} catch (e) {
		log.error("Error handling disconnect-roomy-space", e);
		try {
			await interaction.edit({
				content: "An error occurred while disconnecting.",
			});
		} catch {}
	}
}

// ─── Bridge config resolver ───────────────────────────────────────────

function resolveBridgeConfig(
	configs: BridgeConfig[],
	spaceIdOption: string | undefined,
):
	| { config: BridgeConfig; error?: undefined }
	| { config: undefined; error: string } {
	if (configs.length === 0) {
		return {
			config: undefined,
			error: "No Roomy spaces are connected. Use `/connect-roomy-space` first.",
		};
	}

	if (spaceIdOption) {
		const config = configs.find((c) => c.spaceDid === spaceIdOption);
		if (!config) {
			return {
				config: undefined,
				error: `No bridge found for space \`${spaceIdOption}\` in this guild.`,
			};
		}
		return { config };
	}

	const single = configs[0];
	if (single) {
		return { config: single };
	}

	const spaceList = configs.map((c) => `- \`${c.spaceDid}\``).join("\n");
	return {
		config: undefined,
		error: `Multiple spaces are connected. Specify which one:\n${spaceList}\n\nUse the \`space-id\` option.`,
	};
}

// ─── /roomy-bridge-channel ────────────────────────────────────────────

async function handleBridgeChannel(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	spaceManager: SpaceManager,
	bot: DiscordBotWithCache,
	guildId: string,
): Promise<void> {
	if (!(await safeDefer(interaction, true))) return;

	try {
		const subcommand = interaction.data?.options?.[0];
		if (!subcommand) return;

		const configs = repo.listBridgeConfigsForGuild(guildId);
		const getSubOption = (name: string): string | undefined =>
			getStringOption(subcommand.options, name);

		if (subcommand.name === "add") {
			await handleChannelAdd(
				interaction,
				repo,
				spaceManager,
				bot,
				guildId,
				configs,
				getSubOption,
			);
		} else if (subcommand.name === "remove") {
			await handleChannelRemove(
				interaction,
				repo,
				guildId,
				configs,
				getSubOption,
			);
		} else if (subcommand.name === "list") {
			await handleChannelList(
				interaction,
				repo,
				guildId,
				configs,
				getSubOption,
			);
		}
	} catch (e) {
		log.error("Error handling roomy-bridge-channel", e);
		try {
			await interaction.edit({
				content: "An error occurred while managing the channel allowlist.",
			});
		} catch {}
	}
}

async function handleChannelAdd(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	spaceManager: SpaceManager,
	bot: DiscordBotWithCache,
	guildId: string,
	configs: BridgeConfig[],
	getOption: (name: string) => string | undefined,
): Promise<void> {
	const channelId = getOption("channel");
	if (!channelId) {
		await interaction.edit({ content: "Please specify a channel." });
		return;
	}

	const resolved = resolveBridgeConfig(configs, getOption("space-id"));
	if (!resolved.config) {
		await interaction.edit({ content: resolved.error });
		return;
	}

	const config = resolved.config;
	let switchedToSubset = false;

	if (config.mode === "full") {
		repo.upsertBridgeConfig(guildId, config.spaceDid, "subset");
		switchedToSubset = true;
		log.info(`Switched bridge ${config.spaceDid} from full to subset mode`);
	}

	repo.addToAllowlist(config.spaceDid, channelId, guildId);
	log.info(`Added channel ${channelId} to allowlist for ${config.spaceDid}`);

	let message = `Added <#${channelId}> to the bridge allowlist.`;
	if (switchedToSubset) {
		message +=
			"\n\nSwitched bridge from full to **subset** mode — only allowlisted channels will now be synced. Use `/roomy-bridge-channel add` to add more.";
	}

	await interaction.edit({ content: message });

	backfillSingleChannel(
		createAdapters(bot, spaceManager).discord,
		repo,
		createAdapters(bot, spaceManager).roomy,
		channelId,
		guildId,
	).catch((err) => {
		log.error(`Backfill failed for channel ${channelId}`, err);
	});
}

async function handleChannelRemove(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	_guildId: string,
	configs: BridgeConfig[],
	getOption: (name: string) => string | undefined,
): Promise<void> {
	const channelId = getOption("channel");
	if (!channelId) {
		await interaction.edit({ content: "Please specify a channel." });
		return;
	}

	const resolved = resolveBridgeConfig(configs, getOption("space-id"));
	if (!resolved.config) {
		await interaction.edit({ content: resolved.error });
		return;
	}

	const config = resolved.config;

	if (!repo.isAllowlisted(config.spaceDid, channelId)) {
		await interaction.edit({
			content: `<#${channelId}> is not in the allowlist.`,
		});
		return;
	}

	repo.removeFromAllowlist(config.spaceDid, channelId);
	log.info(
		`Removed channel ${channelId} from allowlist for ${config.spaceDid}`,
	);

	await interaction.edit({
		content: `Removed <#${channelId}> from the bridge allowlist. Existing synced messages are preserved.`,
	});
}

async function handleChannelList(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	_guildId: string,
	configs: BridgeConfig[],
	getOption: (name: string) => string | undefined,
): Promise<void> {
	const resolved = resolveBridgeConfig(configs, getOption("space-id"));
	if (!resolved.config) {
		await interaction.edit({ content: resolved.error });
		return;
	}

	const config = resolved.config;

	if (config.mode === "full") {
		await interaction.edit({
			content: `Bridge \`${config.spaceDid}\` is in **full** mode — all channels are synced. Use \`/roomy-bridge-channel add\` to switch to subset mode.`,
		});
		return;
	}

	const entries = repo.listAllowlistForBridge(config.spaceDid);
	if (entries.length === 0) {
		await interaction.edit({
			content: `No channels in the allowlist for \`${config.spaceDid}\`. Use \`/roomy-bridge-channel add\` to add channels.`,
		});
		return;
	}

	const channelList = entries.map((e) => `- <#${e.channelId}>`).join("\n");
	await interaction.edit({
		content: `**Allowlist for \`${config.spaceDid}\` (${entries.length} channels):**\n${channelList}`,
	});
}

// ─── /roomy-backfill ──────────────────────────────────────────────────

async function handleBackfill(
	interaction: InteractionProperties,
	repo: BridgeRepository,
	spaceManager: SpaceManager,
	bot: DiscordBotWithCache,
	guildId: string,
): Promise<void> {
	if (!(await safeDefer(interaction, true))) return;

	try {
		const configs = repo.listBridgeConfigsForGuild(guildId);
		if (configs.length === 0) {
			await interaction.edit({
				content:
					"No Roomy spaces are connected. Use `/connect-roomy-space` first.",
			});
			return;
		}

		const channelOption = getStringOption(interaction.data?.options, "channel");

		if (channelOption) {
			const channelStr = channelOption.toString();
			repo.resetChannelCursor(channelStr);
			log.info(`Reset cursor for channel ${channelStr}, starting re-backfill`);

			await interaction.edit({
				content: `Re-backfilling <#${channelStr}> from the beginning. Already-synced messages will be skipped.`,
			});

			backfillSingleChannel(
				createAdapters(bot, spaceManager).discord,
				repo,
				createAdapters(bot, spaceManager).roomy,
				channelStr,
				guildId,
			).catch((err) => {
				log.error(`Re-backfill failed for channel ${channelStr}`, err);
			});
		} else {
			const channels = collectGuildChannelIds(bot, repo, configs);
			if (channels.size === 0) {
				await interaction.edit({
					content: "No bridged channels found to backfill.",
				});
				return;
			}

			for (const channelId of channels) {
				repo.resetChannelCursor(channelId);
			}
			log.info(
				`Reset cursors for ${channels.size} channels, starting full re-backfill`,
			);

			await interaction.edit({
				content: `Re-backfilling ${channels.size} channel(s) from the beginning. Already-synced messages will be skipped.`,
			});

			runBackfill(
				createAdapters(bot, spaceManager).discord,
				repo,
				createAdapters(bot, spaceManager).roomy,
			).catch((err) => {
				log.error("Full re-backfill failed", err);
			});
		}
	} catch (e) {
		log.error("Error handling roomy-backfill", e);
		try {
			await interaction.edit({
				content: "An error occurred while triggering re-backfill.",
			});
		} catch {}
	}
}

function collectGuildChannelIds(
	bot: DiscordBotWithCache,
	repo: BridgeRepository,
	configs: BridgeConfig[],
): Set<string> {
	const channels = new Set<string>();

	for (const config of configs) {
		if (config.mode === "full") {
			const guild = bot.cache.guilds.memory.get(BigInt(config.guildId));
			if (!guild?.channels) continue;
			for (const [channelId, channel] of guild.channels) {
				if (MESSAGE_CHANNEL_TYPES.has(channel.type)) {
					channels.add(channelId.toString());
				}
			}
		} else {
			const allowlist = repo.listAllowlistForBridge(config.spaceDid);
			for (const entry of allowlist) {
				channels.add(entry.channelId);
			}
		}
	}

	return channels;
}
