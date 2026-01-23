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
      const spaceId = await registeredBridges.get_spaceId(guildId.toString());
      interaction.respond({
        flags: MessageFlags.Ephemeral,
        content: spaceId
          ? `✅ This Discord server is actively bridged to a Roomy [space](https://roomy.space/${spaceId}).`
          : "🔌 The Discord bridge is not connected to a Roomy space.",
      });
    } else if (interaction.data?.name == "connect-roomy-space") {
      const spaceId = interaction.data.options?.find(
        (x: { name: string; value: unknown }) => x.name == "space-id",
      )?.value as string;

      // Validate the space ID format
      let streamDid: StreamDid;
      try {
        streamDid = StreamDid.assert(spaceId);
      } catch {
        interaction.respond({
          flags: MessageFlags.Ephemeral,
          content: "🛑 Invalid space ID. Please provide a valid stream DID.",
        });
        return;
      }

      // Check if the bridge can access this space
      const client = getRoomyClient();
      const spaceExists = await client.checkStreamExists(streamDid);

      if (!spaceExists) {
        interaction.respond({
          flags: MessageFlags.Ephemeral,
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
        interaction.respond({
          flags: MessageFlags.Ephemeral,
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

      // Respond immediately, then start backfill in background
      interaction.respond({
        flags: MessageFlags.Ephemeral,
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
          console.warn("Bot not ready yet, Discord backfill will happen on next restart");
        }
      } catch (e) {
        console.error(`Error during initial sync for space ${spaceId}:`, e);
      }
    } else if (interaction.data?.name == "disconnect-roomy-space") {
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

        interaction.respond({
          flags: MessageFlags.Ephemeral,
          content: "Successfully disconnected the Roomy space. 🔌",
        });
      } else {
        interaction.respond({
          flags: MessageFlags.Ephemeral,
          content:
            "There is no roomy space connected, so I didn't need to do anything. 🤷‍♀️",
        });
      }
    }
  }
}
