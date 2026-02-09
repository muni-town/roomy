import { RoomyClient } from "@roomy/sdk";
import {
  backfill,
  doneBackfillingFromDiscord,
  getGuildContext,
  hasBridge,
} from "../discord/bot";
import {
  desiredProperties,
  DiscordBot,
  DiscordChannel,
} from "../discord/types.js";
import { initRoomyClient, subscribeToConnectedSpaces } from "../roomy/client";
import { createBot, Intents } from "@discordeno/bot";
import { DISCORD_TOKEN } from "../env";
import { tracer, setDiscordAttrs, recordError } from "../tracing.js";
import {
  handleSlashCommandInteraction,
  slashCommands,
} from "../discord/slashCommands";
import { getRoomKey } from "../utils/room";
import { Deferred } from "@roomy/sdk";
import { registeredBridges } from "../repositories/LevelDBBridgeRepository";

type BridgeOrchestratorState =
  | {
      state: "initialising";
    }
  | {
      state: "backfilling";
      roomy: RoomyClient;
      bot: DiscordBot;
    }
  | {
      state: "listening";
      roomy: RoomyClient;
      bot: DiscordBot;
      appId: string;
    };

/** Bridge Singleton Sync Router
 * The goal for this singleton is to manage initialisation up to the point that it holds
 * the minimum required 'global' state for delegating incoming events to handlers.
 *
 * Three-phase connection backfill process:
 * 1. Backfill connected Roomy spaces to populate sync maps
 * 2. Backfill connected Discord guilds and sync to Roomy
 * 3. Sync required Roomy data to Discord
 *
 * Once a Bridge is backfilled, then it can subscribe to incoming events from Discord and Roomy.
 */
export class BridgeOrchestrator {
  state: BridgeOrchestratorState = { state: "initialising" };

  private constructor(roomy: RoomyClient, bot: DiscordBot, appId: string) {
    this.start();
  }

  async start() {
    let roomy: Awaited<RoomyClient>;
    try {
      roomy = await initRoomyClient();
    } catch (e) {
      if ((e as Error).message?.includes("Stream does not exist")) {
        console.error(
          "\nThe personal stream record exists on PDS but the stream doesn't exist on the Leaf server.\n" +
            "This may happen after a Leaf server reset or data migration.\n" +
            "To fix, you may need to manually delete the stale PDS record:\n" +
            "  1. Find the record at: space.roomy.space.personal (rkey = schema version)\n" +
            "  2. Delete it via your PDS or ATPROTO tools\n" +
            "  3. Restart the bridge to create a new stream\n",
        );
      }
      throw e;
    }

    console.log("Subscribing to connected spaces...");
    const bridges = await registeredBridges.list();

    console.log("bridges", bridges);
    // try {
    //   await subscribeToConnectedSpaces(roomy);
    // } catch (e) {
    //   console.error("Failed to subscribe to connected spaces:", e);
    //   // Continue anyway - some spaces may have failed but we can still run the bot
    // }

    console.log("Connecting to Discord...");

    // const { bot, appId } = await this.startBot();
    // console.log("Discord bridge ready");

    // this.state = {
    //   state: "listening",
    //   roomy,
    //   bot,
    //   appId,
    // };
  }

  /**
   * A single instance of `bot` handles all events incoming from Discord across multiple guilds.
   * The event handlers route each event to Roomy spaces as defined in the persisted mapping.
   */
  async startBot() {
    let appIdPromise = new Deferred<string>();
    const bot = createBot({
      token: DISCORD_TOKEN,
      intents:
        Intents.MessageContent |
        Intents.Guilds |
        Intents.GuildMessages |
        Intents.GuildMessageReactions,
      desiredProperties,
      events: {
        ready(ready) {
          console.log("Discord bot connected", ready);
          tracer.startActiveSpan("discord.bot.ready", (span) => {
            span.setAttribute(
              "discord.application.id",
              ready.applicationId.toString(),
            );
            span.setAttribute("discord.shard.id", ready.shardId);
            span.setAttribute("discord.guilds.count", ready.guilds.length);

            // Set Discord app ID used in `/info` API endpoint.
            appIdPromise.resolve(ready.applicationId.toString());

            // Update discord slash commands.
            bot.helpers.upsertGlobalApplicationCommands(slashCommands);

            // Backfill messages sent while the bridge was offline
            backfill(bot, ready.guilds);

            span.end();
          });
        },

        // Handle slash commands
        async interactionCreate(interaction) {
          console.log("Interaction create event", interaction.data);
          await handleSlashCommandInteraction(interaction);
        },

        async channelCreate(channel) {
          if (!channel.guildId)
            throw new Error(
              "Discord guild ID missing from channel create event",
            );
          if (!(await hasBridge(channel.guildId!))) return;
          const ctx = await getGuildContext(channel.guildId);
          if (!ctx) return;
          console.log("Channel create event", channel, ctx);
          // await getRoomyThreadForChannel(ctx, channel);
        },
        async threadCreate(channel) {
          // Skip during backfill to avoid race conditions
          if (!doneBackfillingFromDiscord) {
            console.log(
              `Skipping threadCreate for ${channel.name} - backfill not complete`,
            );
            return;
          }
          if (!channel.guildId)
            throw new Error(
              "Discord guild ID missing from thread create event",
            );
          if (!(await hasBridge(channel.guildId!))) {
            console.log(
              `Skipping threadCreate for ${channel.name} - no bridge for guild`,
            );
            return;
          }
          const ctx = await getGuildContext(channel.guildId);
          if (!ctx) {
            console.log(
              `Skipping threadCreate for ${channel.name} - no guild context`,
            );
            return;
          }
          console.log(
            `Thread create event: ${channel.name} (id=${channel.id}, parentId=${channel.parentId})`,
          );
          try {
            if (!channel.parentId) {
              console.error(`Thread ${channel.name} has no parent channel`);
              return;
            }
            await ctx.orchestrator.handleDiscordThreadCreate(
              channel,
              channel.parentId,
            );
            await ctx.orchestrator.handleDiscordThreadCreate(
              channel,
              channel.parentId,
            );
            console.log(
              `Successfully created Roomy thread for Discord thread ${channel.name}`,
            );
          } catch (error) {
            console.error(
              `Failed to create Roomy thread for Discord thread ${channel.name}:`,
              error,
            );
          }
        },

        // Handle new messages
        async messageCreate(message) {
          // Skip during backfill to avoid race conditions with cursor tracking
          if (!doneBackfillingFromDiscord) return;
          if (!(await hasBridge(message.guildId!))) return;

          const guildId = message.guildId;
          const channelId = message.channelId;
          if (!guildId) {
            console.error("Guild ID not present on Discord message event");
            return;
          }
          if (!channelId) {
            console.error("Channel ID not present on Discord message event");
            return;
          }

          const ctx = await getGuildContext(guildId);
          if (!ctx) return;
          const roomyRoomId = await ctx.repo.getDiscordId(
            getRoomKey(channelId),
          );

          if (!roomyRoomId) {
            console.warn(
              `Discord channel ${channelId} not synced to Roomy, skipping message`,
            );
            return;
          }

          await ctx.orchestrator.handleDiscordMessageCreate(
            message,
            roomyRoomId,
          );
          await ctx.latestMessagesInChannel.put(
            channelId.toString(),
            message.id.toString(),
          );
        },

        // Handle reaction add
        async reactionAdd(payload) {
          if (!doneBackfillingFromDiscord) return;
          if (!payload.guildId) return;
          if (!(await hasBridge(payload.guildId))) return;

          const ctx = await getGuildContext(payload.guildId);
          if (!ctx) return;
          console.log(
            `[Discord] Reaction add: msg=${payload.messageId} user=${payload.userId} emoji=${payload.emoji.name}`,
          );
          await ctx.orchestrator.handleDiscordReactionAdd(
            payload.messageId,
            payload.channelId,
            payload.userId,
            payload.emoji,
          );
        },

        // Handle reaction remove
        async reactionRemove(payload) {
          if (!doneBackfillingFromDiscord) return;
          if (!payload.guildId) return;
          if (!(await hasBridge(payload.guildId))) return;

          const ctx = await getGuildContext(payload.guildId);
          if (!ctx) return;
          await ctx.orchestrator.handleDiscordReactionRemove(
            payload.messageId,
            payload.channelId,
            payload.userId,
            payload.emoji,
          );
        },

        // Handle message edits
        async messageUpdate(message) {
          // Skip during backfill
          if (!doneBackfillingFromDiscord) return;

          // Skip if not a user edit (embed resolution, pin change, etc.)
          if (!message.editedTimestamp) return;

          if (!message.guildId) return;
          if (!(await hasBridge(message.guildId))) return;

          const ctx = await getGuildContext(message.guildId);
          if (!ctx) return;

          // syncEditToRoomy will skip messages not in syncedIds (including bot messages)
          await ctx.orchestrator.handleDiscordMessageUpdate(message);
        },
      },
    });
    bot.start();
    const appId = await appIdPromise.promise;
    return { bot, appId };
  }
}
