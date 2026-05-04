import {
  ApplicationCommandOptionTypes,
  ButtonStyles,
  type Collection,
  type CreateApplicationCommand,
  DiscordApplicationIntegrationType,
  DiscordInteractionContextType,
  InteractionTypes,
  MessageComponentTypes,
  MessageFlags,
} from "@discordeno/bot";
import { StreamDid } from "@roomy-space/sdk";
import type { BridgeRepository, BridgeConfig } from "../db/repository.ts";
import type { SpaceManager } from "../roomy/space-manager.ts";
import type { DiscordBot, InteractionProperties } from "./types.ts";
import { backfillSingleChannel, runBackfill } from "../services/backfill.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("slash");

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
    description: "Re-backfill from Discord history. Resets cursors so gaps are caught; dedup prevents duplicates.",
    contexts: [DiscordInteractionContextType.Guild],
    integrationTypes: [DiscordApplicationIntegrationType.GuildInstall],
    defaultMemberPermissions: ["ADMINISTRATOR"],
    options: [
      {
        name: "channel",
        description: "A specific channel to re-backfill. Omit to re-backfill all bridged channels.",
        type: ApplicationCommandOptionTypes.Channel,
        required: false,
      },
    ],
  },
] satisfies CreateApplicationCommand[];

// ─── Registration ─────────────────────────────────────────────────────

export async function registerSlashCommands(bot: DiscordBot): Promise<void> {
  await bot.helpers.upsertGlobalApplicationCommands(slashCommands);
  log.info(`Registered ${slashCommands.length} slash commands`);
}

// ─── Interaction age helpers ──────────────────────────────────────────

const DISCORD_EPOCH = 1420070400000n;

function getInteractionAgeMs(interactionId: bigint): number {
  const timestamp = Number((interactionId >> 22n) + DISCORD_EPOCH);
  return Date.now() - timestamp;
}

function isInteractionAlreadyHandled(error: unknown): boolean {
  const errorBody = (error as any)?.cause?.body;
  if (typeof errorBody !== "string") return false;
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
  bot: DiscordBot,
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
    await handleComponentInteraction(interaction, repo, spaceManager, bot, guildId);
    return;
  }
}

async function handleComponentInteraction(
  interaction: InteractionProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
  bot: DiscordBot,
  guildId: string,
): Promise<void> {
  const customId = (interaction as any).data?.customId as string | undefined;
  if (!customId?.startsWith("roomy:")) return;

  const parts = customId.split(":");
  const action = parts[1];

  try {
    if (action === "bridge-mode") {
      await handleBridgeModeButton(interaction, repo, spaceManager, bot, guildId, parts);
    } else if (action === "channel-select") {
      await handleChannelSelect(interaction, repo, spaceManager, bot, guildId, parts);
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
        content:
          "The Discord bridge is not connected to any Roomy spaces.",
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
    const spaceIdOption = interaction.data?.options?.find(
      (x: any) => x.name === "space-id",
    )?.value;

    if (!spaceIdOption || typeof spaceIdOption !== "string") {
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

    // Reject a second full bridge in the same guild
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
              customId: `roomy:bridge-mode:${guildId}:${spaceDid}:full`,
            },
            {
              type: MessageComponentTypes.Button,
              style: ButtonStyles.Secondary,
              label: "Select Specific Channels",
              customId: `roomy:bridge-mode:${guildId}:${spaceDid}:subset`,
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

// customId: roomy:bridge-mode:<guildId>:<spaceDid>:full|subset
// spaceDid contains colons (did:plc:xxx) so reconstruct from parts.slice(3, -1)
async function handleBridgeModeButton(
  interaction: InteractionProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
  bot: DiscordBot,
  guildId: string,
  parts: string[],
): Promise<void> {
  if (!(await safeDefer(interaction, true))) return;

  const mode = parts[parts.length - 1] as "full" | "subset";
  const spaceDid = parts.slice(3, -1).join(":");

  if (mode === "full") {
    try {
      await spaceManager.getOrConnect(spaceDid);
    } catch (e) {
      log.error("Failed to connect to space", e);
      await interaction.edit({
        content: "Could not connect to that space. Make sure the bridge has access.",
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

    runBackfill(bot, repo, spaceManager).catch((err) => {
      log.error(`Initial backfill failed for space ${spaceDid}`, err);
    });
    return;
  }

  // Subset — show channel select menu
  await interaction.edit({
    content: "Select the channels to bridge:",
    components: [
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.SelectMenuChannels,
            customId: `roomy:channel-select:${guildId}:${spaceDid}`,
            channelTypes: [0],
            minValues: 1,
            maxValues: 25,
            placeholder: "Select channels to bridge...",
          } as any,
        ],
      },
    ],
  });
}

// customId: roomy:channel-select:<guildId>:<spaceDid>
async function handleChannelSelect(
  interaction: InteractionProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
  bot: DiscordBot,
  guildId: string,
  parts: string[],
): Promise<void> {
  if (!(await safeDefer(interaction, true))) return;

  const spaceDid = parts.slice(3).join(":");
  const selectedChannels: string[] =
    ((interaction as any).data?.values as string[]) ?? [];

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
      content: "Could not connect to that space. Make sure the bridge has access.",
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

  runBackfill(bot, repo, spaceManager).catch((err) => {
    log.error(`Initial backfill failed for space ${spaceDid}`, err);
  });
}

// ─── /disconnect-roomy-space ──────────────────────────────────────────

async function handleDisconnect(
  interaction: InteractionProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
  guildId: string,
): Promise<void> {
  if (!(await safeDefer(interaction, true))) return;

  try {
    const configs = repo.listBridgeConfigsForGuild(guildId);
    if (configs.length === 0) {
      await interaction.edit({
        content:
          "There are no Roomy spaces connected to disconnect.",
      });
      return;
    }

    const spaceIdOption = interaction.data?.options?.find(
      (x: any) => x.name === "space-id",
    )?.value as string | undefined;

    let targetConfig;
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
      const spaceList = configs
        .map((c) => `- \`${c.spaceDid}\``)
        .join("\n");
      await interaction.edit({
        content: `Multiple spaces are connected. Specify which one:\n${spaceList}\n\nUse \`/disconnect-roomy-space space-id: <did>\`.`,
      });
      return;
    }

    repo.removeBridgeConfig(guildId, targetConfig!.spaceDid);
    log.info(
      `Disconnected space ${targetConfig!.spaceDid} from guild ${guildId}`,
    );

    await interaction.edit({
      content: `Successfully disconnected space \`${targetConfig!.spaceDid}\`.`,
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
): { config: BridgeConfig; error?: undefined } | { config: undefined; error: string } {
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

  if (configs.length === 1) {
    return { config: configs[0]! };
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
  bot: DiscordBot,
  guildId: string,
): Promise<void> {
  if (!(await safeDefer(interaction, true))) return;

  try {
    const subcommand = interaction.data?.options?.[0];
    if (!subcommand) return;

    const configs = repo.listBridgeConfigsForGuild(guildId);
    const getSubOption = (name: string) =>
      (subcommand.options as any[])?.find((o: any) => o.name === name)
        ?.value as string | undefined;

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
      await handleChannelRemove(interaction, repo, guildId, configs, getSubOption);
    } else if (subcommand.name === "list") {
      await handleChannelList(interaction, repo, guildId, configs, getSubOption);
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
  bot: DiscordBot,
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

  backfillSingleChannel(bot, repo, spaceManager, channelId, guildId).catch((err) => {
    log.error(`Backfill failed for channel ${channelId}`, err);
  });
}

async function handleChannelRemove(
  interaction: InteractionProperties,
  repo: BridgeRepository,
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

  if (!repo.isAllowlisted(config.spaceDid, channelId)) {
    await interaction.edit({
      content: `<#${channelId}> is not in the allowlist.`,
    });
    return;
  }

  repo.removeFromAllowlist(config.spaceDid, channelId);
  log.info(`Removed channel ${channelId} from allowlist for ${config.spaceDid}`);

  await interaction.edit({
    content: `Removed <#${channelId}> from the bridge allowlist. Existing synced messages are preserved.`,
  });
}

async function handleChannelList(
  interaction: InteractionProperties,
  repo: BridgeRepository,
  guildId: string,
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
  bot: DiscordBot,
  guildId: string,
): Promise<void> {
  if (!(await safeDefer(interaction, true))) return;

  try {
    const configs = repo.listBridgeConfigsForGuild(guildId);
    if (configs.length === 0) {
      await interaction.edit({
        content: "No Roomy spaces are connected. Use `/connect-roomy-space` first.",
      });
      return;
    }

    const channelOption = interaction.data?.options?.find(
      (x: any) => x.name === "channel",
    )?.value as string | undefined;

    if (channelOption) {
      // Single-channel re-backfill
      const channelStr = channelOption.toString();
      repo.resetChannelCursor(channelStr);
      log.info(`Reset cursor for channel ${channelStr}, starting re-backfill`);

      await interaction.edit({
        content: `Re-backfilling <#${channelStr}> from the beginning. Already-synced messages will be skipped.`,
      });

      backfillSingleChannel(bot, repo, spaceManager, channelStr, guildId).catch((err) => {
        log.error(`Re-backfill failed for channel ${channelStr}`, err);
      });
    } else {
      // Full re-backfill: reset all cursors for this guild's channels
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
      log.info(`Reset cursors for ${channels.size} channels, starting full re-backfill`);

      await interaction.edit({
        content: `Re-backfilling ${channels.size} channel(s) from the beginning. Already-synced messages will be skipped.`,
      });

      runBackfill(bot, repo, spaceManager).catch((err) => {
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
  bot: DiscordBot,
  repo: BridgeRepository,
  configs: BridgeConfig[],
): Set<string> {
  const channels = new Set<string>();

  for (const config of configs) {
    if (config.mode === "full") {
      const cached = bot as unknown as {
        cache: {
          guilds: {
            memory: Collection<bigint, { id: bigint; channels?: Collection<bigint, { id: bigint; type: number }> }>;
          };
        };
      };
      const guild = cached.cache.guilds.memory.get(BigInt(config.guildId));
      if (!guild?.channels) continue;
      for (const [channelId, channel] of guild.channels) {
        if ([0, 5, 11, 12].includes(channel.type)) {
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
