import {
  ApplicationCommandOptionTypes,
  CreateApplicationCommand,
  DiscordApplicationIntegrationType,
  DiscordInteractionContextType,
  Interaction,
  InteractionTypes,
  MessageFlags,
} from "@discordeno/bot";

import {
  discordLatestMessageInChannelForBridge,
  discordWebhookTokensForBridge,
  registeredBridges,
  syncedIdsForBridge,
} from "../db.js";
import { getRoomyClient, subscribeToSpace } from "../roomy/client.js";
import { StreamDid } from "@roomy/sdk";
import { backfillGuild, botState } from "./bot.js";

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
    description: "Disconnect the bridged Roomy space if one is connected.",
    contexts: [DiscordInteractionContextType.Guild],
    integrationTypes: [DiscordApplicationIntegrationType.GuildInstall],
    defaultMemberPermissions: ["ADMINISTRATOR"],
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

/**
 * Get the age of an interaction in milliseconds based on its snowflake ID.
 */
function getInteractionAgeMs(interactionId: bigint): number {
  const timestamp = Number((interactionId >> 22n) + DISCORD_EPOCH);
  return Date.now() - timestamp;
}

/**
 * Check if an error indicates the interaction was already handled.
 * Discord error codes:
 * - 40060: Interaction has already been acknowledged
 * - 10062: Unknown interaction (expired or invalid)
 */
function isInteractionAlreadyHandled(error: any): boolean {
  const errorBody = error?.cause?.body;
  if (typeof errorBody !== 'string') return false;

  try {
    const parsed = JSON.parse(errorBody);
    return parsed?.code === 40060 || parsed?.code === 10062;
  } catch {
    // Fallback to string matching
    return errorBody.includes("already been acknowledged") ||
           errorBody.includes("Unknown Interaction");
  }
}

/**
 * Safely respond to an interaction immediately.
 * Returns true if successful, false if already handled by a previous bot instance.
 */
async function safeRespond(
  interaction: any,
  content: string,
  ephemeral: boolean = true
): Promise<boolean> {
  const ageMs = getInteractionAgeMs(BigInt(interaction.id));
  console.log(`[${interaction.data?.name}] Responding to interaction ${interaction.id} (age: ${ageMs}ms)`);

  // Skip interactions older than 2.5s (Discord timeout is 3s)
  if (ageMs > 2500) {
    console.log(`[${interaction.data?.name}] Skipping stale interaction (${ageMs}ms old)`);
    return false;
  }

  try {
    await interaction.respond({
      flags: ephemeral ? MessageFlags.Ephemeral : 0,
      content,
    });
    return true;
  } catch (e: any) {
    if (isInteractionAlreadyHandled(e)) {
      console.log(`[${interaction.data?.name}] Interaction already handled, skipping`);
      return false;
    }
    console.error(`[${interaction.data?.name}] Failed to respond:`, e?.cause?.body || e?.message);
    throw e;
  }
}

/**
 * Safely defer an interaction for commands that need time to process.
 * Returns true if successful, false if already handled.
 */
async function safeDefer(interaction: any, ephemeral: boolean): Promise<boolean> {
  const ageMs = getInteractionAgeMs(BigInt(interaction.id));
  console.log(`[${interaction.data?.name}] Deferring interaction ${interaction.id} (age: ${ageMs}ms)`);

  if (ageMs > 2500) {
    console.log(`[${interaction.data?.name}] Skipping stale interaction (${ageMs}ms old)`);
    return false;
  }

  try {
    await interaction.defer(ephemeral);
    return true;
  } catch (e: any) {
    if (isInteractionAlreadyHandled(e)) {
      console.log(`[${interaction.data?.name}] Interaction already handled, skipping`);
      return false;
    }
    console.error(`[${interaction.data?.name}] Failed to defer:`, e?.cause?.body || e?.message);
    throw e;
  }
}

/** Handle Discord slash command interactions */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleSlashCommandInteraction(interaction: any) {
  const guildId = interaction.guildId;
  if (!guildId) {
    console.error("Guild ID missing from interaction:", interaction);
    interaction.respond({
      flags: MessageFlags.Ephemeral,
      content: "🛑 There was an error connecting your space. 😕",
    });
    return;
  }

  if (interaction.type == InteractionTypes.ApplicationCommand) {
    if (interaction.data?.name == "roomy-status") {
      // Defer immediately to avoid 3-second timeout
      if (!await safeDefer(interaction, true)) return;
      try {
        const spaceId = await registeredBridges.get_spaceId(guildId.toString());
        await interaction.edit({
          content: spaceId
            ? `✅ This Discord server is actively bridged to a Roomy [space](https://roomy.space/${spaceId}).`
            : "🔌 The Discord bridge is not connected to a Roomy space.",
        });
      } catch (e) {
        console.error("Error handling roomy-status command:", e);
        try {
          await interaction.edit({
            content: "🛑 An error occurred while checking status.",
          });
        } catch {
          // Interaction may have expired
        }
      }
    } else if (interaction.data?.name == "connect-roomy-space") {
      // Defer immediately since this command does async work that may take > 3 seconds
      // Discord interactions timeout after 3 seconds without acknowledgment
      if (!await safeDefer(interaction, true)) return;

      try {
        const spaceId = interaction.data.options?.find(
          (x: { name: string; value: unknown }) => x.name == "space-id",
        )?.value as string;

        // Validate the space ID format
        let streamDid: StreamDid;
        try {
          streamDid = StreamDid.assert(spaceId);
        } catch {
          await interaction.edit({
            content: "🛑 Invalid space ID. Please provide a valid stream DID.",
          });
          return;
        }

        // Check if the bridge can access this space
        const client = getRoomyClient();
        const spaceExists = await client.checkStreamExists(streamDid);

        if (!spaceExists) {
          await interaction.edit({
            content:
              "🛑 Could not find a space with that ID, or the bridge doesn't have access. " +
              'Make sure you\'ve clicked "Grant Access" in the Discord bridge settings page first.',
          });
          return;
        }

        const existingRegistration = await registeredBridges.get_spaceId(
          guildId.toString(),
        );
        if (existingRegistration) {
          await interaction.edit({
            content:
              `🛑 This Discord server is already bridged to another Roomy [space](https://roomy.space/${existingRegistration}). ` +
              "If you want to connect to a new space, first disconnect it using the `/disconnect-roomy-space` command.",
          });
          return;
        }

        await registeredBridges.register({
          guildId: guildId.toString(),
          spaceId,
        });

        // Update the deferred response
        await interaction.edit({
          content: "Roomy space has been connected! Starting sync... 🥳",
        });

        // Subscribe to the Roomy space (backfills existing Roomy events)
        try {
          console.log(`Subscribing to newly connected space ${spaceId}...`);
          await subscribeToSpace(client, streamDid);
          console.log(`Subscribed to space ${spaceId}`);

          // Trigger Discord backfill for this guild
          if (botState.bot) {
            console.log(`Starting Discord backfill for guild ${guildId}...`);
            await backfillGuild(botState.bot, guildId);
            console.log(`Discord backfill complete for guild ${guildId}`);
          } else {
            console.warn(
              "Bot not ready yet, Discord backfill will happen on next restart",
            );
          }
        } catch (e) {
          console.error(`Error during initial sync for space ${spaceId}:`, e);
        }
      } catch (e) {
        console.error("Error handling connect-roomy-space command:", e);
        // Try to update the deferred response with an error message
        try {
          await interaction.edit({
            content: "🛑 An error occurred while connecting the space. Please try again.",
          });
        } catch {
          // Interaction may have expired, nothing we can do
        }
      }
    } else if (interaction.data?.name == "disconnect-roomy-space") {
      // Defer immediately to avoid 3-second timeout
      if (!await safeDefer(interaction, true)) return;
      try {
        const roomySpace = await registeredBridges.get_spaceId(
          guildId.toString(),
        );
        if (roomySpace) {
          registeredBridges.unregister({
            guildId: guildId.toString(),
            spaceId: roomySpace,
          });
          await syncedIdsForBridge({
            discordGuildId: guildId,
            roomySpaceId: roomySpace,
          }).clear();
          await discordLatestMessageInChannelForBridge({
            discordGuildId: guildId,
            roomySpaceId: roomySpace,
          }).clear();
          await discordWebhookTokensForBridge({
            discordGuildId: guildId,
            roomySpaceId: roomySpace,
          }).clear();

          await interaction.edit({
            content: "Successfully disconnected the Roomy space. 🔌",
          });
        } else {
          await interaction.edit({
            content:
              "There is no roomy space connected, so I didn't need to do anything. 🤷‍♀️",
          });
        }
      } catch (e) {
        console.error("Error handling disconnect-roomy-space command:", e);
        try {
          await interaction.edit({
            content: "🛑 An error occurred while disconnecting.",
          });
        } catch {
          // Interaction may have expired
        }
      }
    }
  }
}
