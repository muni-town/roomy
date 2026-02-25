import {
  ApplicationCommandOptionTypes,
  CreateApplicationCommand,
  DiscordApplicationIntegrationType,
  DiscordInteractionContextType,
  InteractionTypes,
  MessageComponentTypes,
  MessageFlags,
  ButtonStyles,
} from "@discordeno/bot";

import { StreamDid } from "@roomy/sdk";
import type { Bridge } from "../Bridge.js";
import type { BridgeConfig } from "../repositories/BridgeRepository.js";
import { bridgeConfigs } from "../repositories/LevelDBBridgeRepository.js";
import {
  createBridgeRole,
  deleteBridgeRole,
  setChannelBridgePermissions,
} from "./roles.js";
import { InteractionProperties } from "./types.js";
import type { BridgeOrchestrator } from "../BridgeOrchestrator.js";

export const slashCommands = [
  {
    name: "connect-roomy-space",
    description:
      "Connect a Roomy space to this Discord guild with a 2-way bridge.",
    contexts: [DiscordInteractionContextType.Guild],
    integrationTypes: [DiscordApplicationIntegrationType.GuildInstall],
    defaultMemberPermissions: ["ADMINISTRATOR"],
    options: [
      {
        name: "space-id",
        description: "The ID of the Roomy space to connect to.",
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

/** Discord epoch: January 1, 2015 00:00:00 UTC */
const DISCORD_EPOCH = 1420070400000n;

function getInteractionAgeMs(interactionId: bigint): number {
  const timestamp = Number((interactionId >> 22n) + DISCORD_EPOCH);
  return Date.now() - timestamp;
}

function isInteractionAlreadyHandled(error: any): boolean {
  const errorBody = error?.cause?.body;
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

export async function safeRespond(
  interaction: InteractionProperties,
  content: string,
  ephemeral: boolean = true,
): Promise<boolean> {
  const ageMs = getInteractionAgeMs(BigInt(interaction.id));
  if (ageMs > 2500) {
    console.log(`[slash] Skipping stale interaction (${ageMs}ms old)`);
    return false;
  }

  try {
    await interaction.respond({
      flags: ephemeral ? MessageFlags.Ephemeral : 0,
      content,
    });
    return true;
  } catch (e: any) {
    if (isInteractionAlreadyHandled(e)) return false;
    throw e;
  }
}

export async function safeDefer(
  interaction: InteractionProperties,
  ephemeral: boolean,
): Promise<boolean> {
  const ageMs = getInteractionAgeMs(BigInt(interaction.id));
  if (ageMs > 2500) {
    console.log(`[slash] Skipping stale interaction (${ageMs}ms old)`);
    return false;
  }

  try {
    await interaction.defer(ephemeral);
    return true;
  } catch (e: any) {
    if (isInteractionAlreadyHandled(e)) return false;
    throw e;
  }
}

// ─── Slash command handler ───────────────────────────────────────────

export async function handleSlashCommandInteraction(ctx: {
  interaction: InteractionProperties;
  guildId: bigint;
  spaceExists: (did: StreamDid) => Promise<boolean>;
  createBridge: (
    spaceId: StreamDid,
    guildId: bigint,
    config: BridgeConfig,
  ) => Promise<Bridge>;
  deleteBridge: (spaceId: string) => void;
  bridges: Bridge[];
}) {
  if (ctx.interaction.type !== InteractionTypes.ApplicationCommand) return;

  const commandName = ctx.interaction.data?.name;

  if (commandName === "roomy-status") {
    await handleRoomyStatus(ctx);
  } else if (commandName === "connect-roomy-space") {
    await handleConnectRoomySpace(ctx);
  } else if (commandName === "disconnect-roomy-space") {
    await handleDisconnectRoomySpace(ctx);
  }
}

// ─── roomy-status ────────────────────────────────────────────────────

async function handleRoomyStatus(ctx: {
  interaction: InteractionProperties;
  bridges: Bridge[];
}) {
  if (!(await safeDefer(ctx.interaction, true))) return;
  try {
    if (ctx.bridges.length === 0) {
      await ctx.interaction.edit({
        content: "🔌 The Discord bridge is not connected to any Roomy spaces.",
      });
      return;
    }

    const lines = ctx.bridges.map((b) => {
      const cfg = b.config;
      const channelInfo =
        cfg.mode === "subset"
          ? `${cfg.channels.length} channel(s)`
          : "all channels";
      return `- [${b.connectedSpace.streamDid}](https://roomy.space/${b.connectedSpace.streamDid}) (${cfg.mode} — ${channelInfo})`;
    });

    await ctx.interaction.edit({
      content: `✅ **Connected bridges (${ctx.bridges.length}):**\n${lines.join("\n")}`,
    });
  } catch (e) {
    console.error("Error handling roomy-status:", e);
    try {
      await ctx.interaction.edit({
        content: "🛑 An error occurred while checking status.",
      });
    } catch {}
  }
}

// ─── connect-roomy-space ─────────────────────────────────────────────

async function handleConnectRoomySpace(ctx: {
  interaction: InteractionProperties;
  guildId: bigint;
  spaceExists: (did: StreamDid) => Promise<boolean>;
  createBridge: (
    spaceId: StreamDid,
    guildId: bigint,
    config: BridgeConfig,
  ) => Promise<Bridge>;
  bridges: Bridge[];
}) {
  if (!(await safeDefer(ctx.interaction, true))) return;

  try {
    const spaceId = ctx.interaction.data?.options?.find(
      (x: any) => x.name === "space-id",
    )?.value;

    let streamDid: StreamDid;
    try {
      streamDid = StreamDid.assert(spaceId);
    } catch {
      await ctx.interaction.edit({
        content: "🛑 Invalid space ID. Please provide a valid stream DID.",
      });
      return;
    }

    const exists = await ctx.spaceExists(streamDid);
    if (!exists) {
      await ctx.interaction.edit({
        content:
          "🛑 Could not find a space with that ID, or the bridge doesn't have access. " +
          'Make sure you\'ve clicked "Grant Access" in the Discord bridge settings page first.',
      });
      return;
    }

    // Check if this exact space is already connected
    const alreadyConnected = ctx.bridges.some(
      (b) => b.connectedSpace.streamDid === streamDid,
    );
    if (alreadyConnected) {
      await ctx.interaction.edit({
        content: `🛑 This space is already bridged to this guild. Use \`/roomy-status\` to see connected spaces.`,
      });
      return;
    }

    // Determine what mode options to offer
    const existingModes = ctx.bridges.map((b) => b.config.mode);
    const hasFullBridge = existingModes.includes("full");
    const hasSubsetBridges = existingModes.includes("subset");

    // If guild already has a full bridge, can't add more
    if (hasFullBridge) {
      await ctx.interaction.edit({
        content:
          "🛑 This guild already has a full bridge. Disconnect it first with `/disconnect-roomy-space`, or switch to subset mode.",
      });
      return;
    }

    // If guild already has subset bridges, go straight to channel select
    if (hasSubsetBridges) {
      await ctx.interaction.edit({
        content:
          "This guild already has subset bridges. Select the channels for this new bridge:",
        components: [
          {
            type: MessageComponentTypes.ActionRow,
            components: [
              {
                type: MessageComponentTypes.SelectMenuChannels,
                customId: `roomy:channel-select:${ctx.guildId}:${streamDid}`,
                channelTypes: [0], // GUILD_TEXT only
                minValues: 1,
                maxValues: 25,
                placeholder: "Select channels to bridge...",
              } as any,
            ],
          },
        ],
      });
      return;
    }

    // No existing bridges — offer choice between full and subset
    await ctx.interaction.edit({
      content: "How would you like to bridge this space?",
      components: [
        {
          type: MessageComponentTypes.ActionRow,
          components: [
            {
              type: MessageComponentTypes.Button,
              style: ButtonStyles.Primary,
              label: "Bridge All Channels",
              customId: `roomy:bridge-mode:${ctx.guildId}:${streamDid}:full`,
            },
            {
              type: MessageComponentTypes.Button,
              style: ButtonStyles.Secondary,
              label: "Select Specific Channels",
              customId: `roomy:bridge-mode:${ctx.guildId}:${streamDid}:subset`,
            },
          ],
        },
      ],
    });
  } catch (e) {
    console.error("Error handling connect-roomy-space:", e);
    try {
      await ctx.interaction.edit({
        content:
          "🛑 An error occurred while connecting the space. Please try again.",
      });
    } catch {}
  }
}

// ─── disconnect-roomy-space ──────────────────────────────────────────

async function handleDisconnectRoomySpace(ctx: {
  interaction: InteractionProperties;
  guildId: bigint;
  deleteBridge: (spaceId: string) => void;
  bridges: Bridge[];
}) {
  if (!(await safeDefer(ctx.interaction, true))) return;

  try {
    if (ctx.bridges.length === 0) {
      await ctx.interaction.edit({
        content: "There are no Roomy spaces connected to disconnect.",
      });
      return;
    }

    // Check if a specific space-id was provided
    const spaceIdOption = ctx.interaction.data?.options?.find(
      (x: any) => x.name === "space-id",
    )?.value as string | undefined;

    let targetBridge: Bridge | undefined;

    if (spaceIdOption) {
      targetBridge = ctx.bridges.find(
        (b) => b.connectedSpace.streamDid === spaceIdOption,
      );
      if (!targetBridge) {
        await ctx.interaction.edit({
          content: `🛑 No bridge found for space \`${spaceIdOption}\` in this guild.`,
        });
        return;
      }
    } else if (ctx.bridges.length === 1) {
      targetBridge = ctx.bridges[0];
    } else {
      // Multiple bridges, no specific one requested — show select menu
      await ctx.interaction.edit({
        content: "Multiple spaces are connected. Select which to disconnect:",
        components: [
          {
            type: MessageComponentTypes.ActionRow,
            components: [
              {
                type: MessageComponentTypes.SelectMenu,
                customId: `roomy:disconnect-select:${ctx.guildId}`,
                options: ctx.bridges.map((b) => ({
                  label: `${b.connectedSpace.streamDid.slice(0, 40)}...`,
                  value: b.connectedSpace.streamDid,
                  description: `Mode: ${b.config.mode}`,
                })),
                placeholder: "Select a space to disconnect...",
              } as any,
            ],
          },
        ],
      });
      return;
    }

    // Disconnect the target bridge
    await disconnectBridge(targetBridge!, ctx.guildId, ctx.deleteBridge);

    await ctx.interaction.edit({
      content: `Successfully disconnected space \`${targetBridge!.connectedSpace.streamDid}\`. 🔌`,
    });
  } catch (e) {
    console.error("Error handling disconnect-roomy-space:", e);
    try {
      await ctx.interaction.edit({
        content: "🛑 An error occurred while disconnecting.",
      });
    } catch {}
  }
}

// ─── Component interaction handler ───────────────────────────────────

export async function handleComponentInteraction(ctx: {
  interaction: InteractionProperties;
  guildId: bigint;
  orchestrator: BridgeOrchestrator;
}) {
  const customId = (ctx.interaction as any).data?.customId as string;
  if (!customId?.startsWith("roomy:")) return;

  const parts = customId.split(":");
  const action = parts[1];

  try {
    if (action === "bridge-mode") {
      await handleBridgeModeButton(ctx, parts);
    } else if (action === "channel-select") {
      await handleChannelSelect(ctx, parts);
    } else if (action === "disconnect-select") {
      await handleDisconnectSelect(ctx);
    }
  } catch (e) {
    console.error(
      `[slash] Error handling component interaction ${customId}:`,
      e,
    );
    try {
      await ctx.interaction.respond({
        flags: MessageFlags.Ephemeral,
        content: "🛑 An error occurred. Please try again.",
      });
    } catch {}
  }
}

// ─── Button: bridge-mode ─────────────────────────────────────────────

async function handleBridgeModeButton(
  ctx: {
    interaction: InteractionProperties;
    guildId: bigint;
    orchestrator: BridgeOrchestrator;
  },
  parts: string[],
) {
  // customId: roomy:bridge-mode:${guildId}:${spaceId}:full|subset
  const spaceId = parts.slice(3, 6).join(":") as string;
  const mode = parts[6] as "full" | "subset";

  if (!(await safeDefer(ctx.interaction, true))) return;

  console.log("handling bridge mode button", parts);

  if (mode === "full") {
    // Check no subset bridges exist
    const existingBridges = ctx.orchestrator.getBridgesForGuild(ctx.guildId);
    if (existingBridges.some((b) => b.config.mode === "subset")) {
      await ctx.interaction.edit({
        content:
          "🛑 Cannot add a full bridge while subset bridges exist. Disconnect them first.",
      });
      return;
    }

    const config: BridgeConfig = {
      guildId: ctx.guildId.toString(),
      spaceId,
      mode: "full",
    };

    await bridgeConfigs.register(config);
    const current = await ctx.orchestrator.state.transitionedTo("ready");

    const spaceExists = await current.roomy.getSpaceInfo(spaceId as StreamDid);
    if (!spaceExists?.name) {
      await ctx.interaction.edit({
        content: "🛑 Could not access the space. Check bridge permissions.",
      });
      return;
    }

    await ctx.orchestrator.createBridge(
      spaceId as StreamDid,
      ctx.guildId,
      config,
    );

    await ctx.interaction.edit({
      content: "Roomy space connected in **full** mode! Starting sync... 🥳",
      components: [],
    });
  } else {
    // Subset mode — show channel select
    await ctx.interaction.edit({
      content: "Select the channels to bridge:",
      components: [
        {
          type: MessageComponentTypes.ActionRow,
          components: [
            {
              type: MessageComponentTypes.SelectMenuChannels,
              customId: `roomy:channel-select:${ctx.guildId}:${spaceId}`,
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
}

// ─── Channel select handler ──────────────────────────────────────────

async function handleChannelSelect(
  ctx: {
    interaction: InteractionProperties;
    guildId: bigint;
    orchestrator: BridgeOrchestrator;
  },
  parts: string[],
) {
  // customId: roomy:channel-select:${guildId}:${spaceId}
  const spaceId = parts.slice(3, 6).join(":") as string;

  if (!(await safeDefer(ctx.interaction, true))) return;

  // Extract selected channel IDs from the interaction data
  const selectedChannels: string[] =
    ((ctx.interaction as any).data?.values as string[]) ?? [];

  if (selectedChannels.length === 0) {
    await ctx.interaction.edit({
      content: "🛑 No channels selected. Please try again.",
      components: [],
    });
    return;
  }

  // Validate no overlap with existing bridges
  const existingBridges = ctx.orchestrator.getBridgesForGuild(ctx.guildId);
  const existingChannels = new Set(
    existingBridges.flatMap((b) =>
      b.config.mode === "subset" ? b.config.channels : [],
    ),
  );
  const overlapping = selectedChannels.filter((ch) => existingChannels.has(ch));
  if (overlapping.length > 0) {
    await ctx.interaction.edit({
      content: `🛑 Channel(s) <#${overlapping.join(">, <#")}> already belong to another bridge. Each channel can only be in one bridge.`,
      components: [],
    });
    return;
  }

  // Get space name for role
  const current = await ctx.orchestrator.state.transitionedTo("ready");
  const spaceInfo = await current.roomy.getSpaceInfo(spaceId as StreamDid);
  const spaceName = spaceInfo?.name ?? spaceId.slice(0, 20);

  // Create bot-managed role
  const roleId = await createBridgeRole(current.bot, ctx.guildId, spaceName);

  // Set permissions on selected channels
  await setChannelBridgePermissions(current.bot, selectedChannels, roleId);

  const config: BridgeConfig = {
    guildId: ctx.guildId.toString(),
    spaceId,
    mode: "subset",
    channels: selectedChannels,
    roleId,
  };

  await bridgeConfigs.register(config);
  await ctx.orchestrator.createBridge(
    spaceId as StreamDid,
    ctx.guildId,
    config,
  );

  await ctx.interaction.edit({
    content: `Roomy space connected in **subset** mode with ${selectedChannels.length} channel(s)! Starting sync... 🥳`,
    components: [],
  });
}

// ─── Disconnect select handler ───────────────────────────────────────

async function handleDisconnectSelect(ctx: {
  interaction: InteractionProperties;
  guildId: bigint;
  orchestrator: BridgeOrchestrator;
}) {
  if (!(await safeDefer(ctx.interaction, true))) return;

  const selectedSpaceId = (
    (ctx.interaction as any).data?.values as string[]
  )?.[0];
  if (!selectedSpaceId) {
    await ctx.interaction.edit({
      content: "🛑 No space selected.",
      components: [],
    });
    return;
  }

  const bridge = ctx.orchestrator
    .getBridgesForGuild(ctx.guildId)
    .find((b) => b.connectedSpace.streamDid === selectedSpaceId);

  if (!bridge) {
    await ctx.interaction.edit({
      content: "🛑 Bridge not found for the selected space.",
      components: [],
    });
    return;
  }

  await disconnectBridge(bridge, ctx.guildId, (spaceId) => {
    ctx.orchestrator.bridges.delete(`${ctx.guildId}:${spaceId}`);
  });

  await ctx.interaction.edit({
    content: `Successfully disconnected space \`${selectedSpaceId}\`. 🔌`,
    components: [],
  });
}

// ─── Shared disconnect logic ─────────────────────────────────────────

async function disconnectBridge(
  bridge: Bridge,
  guildId: bigint,
  deleteBridge: (spaceId: string) => void,
) {
  const spaceId = bridge.connectedSpace.streamDid;

  // Delete bot-managed role if it exists (subset mode)
  const cfg = bridge.config;
  if (cfg.mode === "subset") {
    await deleteBridgeRole(bridge.bot, guildId, cfg.roleId);
  }

  await bridge.disconnect();
  await bridgeConfigs.unregister(guildId.toString(), spaceId);
  deleteBridge(spaceId);
}
