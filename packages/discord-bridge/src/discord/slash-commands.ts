import {
  ApplicationCommandOptionTypes,
  type CreateApplicationCommand,
  DiscordApplicationIntegrationType,
  DiscordInteractionContextType,
  InteractionTypes,
  MessageFlags,
} from "@discordeno/bot";
import { StreamDid } from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { SpaceManager } from "../roomy/space-manager.ts";
import type { DiscordBot, InteractionProperties } from "./types.ts";
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
): Promise<void> {
  if (interaction.type !== InteractionTypes.ApplicationCommand) return;
  if (!interaction.guildId) return;

  const guildId = interaction.guildId.toString();
  const commandName = interaction.data?.name;

  if (commandName === "roomy-status") {
    await handleStatus(interaction, repo, guildId);
  } else if (commandName === "connect-roomy-space") {
    await handleConnect(interaction, repo, spaceManager, guildId);
  } else if (commandName === "disconnect-roomy-space") {
    await handleDisconnect(interaction, repo, spaceManager, guildId);
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
  spaceManager: SpaceManager,
  guildId: string,
): Promise<void> {
  if (!(await safeDefer(interaction, true))) return;

  try {
    const spaceIdOption = interaction.data?.options?.find(
      (x: any) => x.name === "space-id",
    )?.value;

    if (!spaceIdOption || typeof spaceIdOption !== "string") {
      await interaction.edit({
        content: "Please provide a valid space ID.",
      });
      return;
    }

    let spaceDid: string;
    try {
      spaceDid = StreamDid.assert(spaceIdOption);
    } catch {
      await interaction.edit({
        content:
          "Invalid space ID. Please provide a valid stream DID.",
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

    try {
      await spaceManager.getOrConnect(spaceDid);
    } catch (e) {
      log.error("Failed to connect to space", e);
      await interaction.edit({
        content:
          "Could not connect to that space. Make sure the space DID is correct and the bridge has access.",
      });
      return;
    }

    repo.upsertBridgeConfig(guildId, spaceDid, "full");
    log.info(`Connected space ${spaceDid} to guild ${guildId}`);

    await interaction.edit({
      content: `Roomy space \`${spaceDid}\` connected in full mode! Starting sync...`,
    });
  } catch (e) {
    log.error("Error handling connect-roomy-space", e);
    try {
      await interaction.edit({
        content:
          "An error occurred while connecting the space.",
      });
    } catch {}
  }
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
