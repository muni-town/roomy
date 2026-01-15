import {
  ApplicationCommandOptionTypes,
  CreateApplicationCommand,
  DiscordApplicationIntegrationType,
  DiscordInteractionContextType,
  Interaction,
  InteractionTypes,
  MessageFlags,
} from "@discordeno/bot";

// import { co, isSpaceAdmin, RoomyEntity } from "@roomy-chat/sdk";
import {
  discordLatestMessageInChannelForBridge,
  discordWebhookTokensForBridge,
  registeredBridges,
  syncedIdsForBridge,
} from "../db.js";

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

      // let space: co.loaded<typeof RoomyEntity> | null = null;
      // space = await RoomyEntity.load(spaceId, {
      //   resolve: {
      //     components: {
      //       $each: true,
      //     },
      //   },
      // });

      // if (!space) {
      //   interaction.respond({
      //     flags: MessageFlags.Ephemeral,
      //     content: "🛑 Could not find a space with that ID. 😕",
      //   });
      //   return;
      // }

      // const hasPermissions = await isSpaceAdmin(jazz, space);
      // if (!hasPermissions) {
      //   interaction.respond({
      //     flags: MessageFlags.Ephemeral,
      //     content:
      //       "🛑 The Discord bot is missing permissions to your Roomy space. " +
      //       "Don't worry that's easy to fix!\n\nClick \"Grant Access\" in the Discord bridge " +
      //       "settings page for your space in Roomy, then come back and try to connect again.",
      //   });
      //   return;
      // }

      const existingRegistration = await registeredBridges.get_spaceId(
        guildId.toString(),
      );
      if (existingRegistration) {
        console.log("Existing registration", existingRegistration);
        // interaction.respond({
        //   flags: MessageFlags.Ephemeral,
        //   content:
        //     `🛑 This Discord server is already bridge to another Roomy [space](https://roomy.space/${existingRegistration}).` +
        //     " If you want to connect to a new space, first disconnect it using the `/disconnect-roomy-space` command.",
        // });
        return;
      }

      await registeredBridges.register({
        guildId: guildId.toString(),
        spaceId,
      });

      interaction.respond({
        flags: MessageFlags.Ephemeral,
        content: "Roomy space has been connected! 🥳",
      });
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
