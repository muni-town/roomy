import {
  Bot,
  ChannelTypes,
  CompleteDesiredProperties,
  createBot,
  Intents,
  Message,
  RecursivePartial,
  SetupDesiredProps,
  TransformersDesiredProperties,
  avatarUrl,
  Channel,
} from "@discordeno/bot";
import { trace } from "@opentelemetry/api";
import { DISCORD_TOKEN } from "../env.js";
import {
  handleSlashCommandInteraction,
  slashCommands,
} from "./slashCommands.js";
import { desiredProperties, DiscordBot, DiscordChannel } from "./types.js";

import {
  discordLatestMessageInChannelForBridge,
  discordWebhookTokensForBridge,
  LatestMessages,
  registeredBridges,
  SyncedIds,
  syncedIdsForBridge,
} from "../db.js";
import { GuildContext } from "../types.js";
import {
  ensureRoomyChannelForDiscordChannel,
  ensureRoomySidebarForCategoriesAndChannels,
  ensureRoomyThreadForDiscordThread,
} from "../roomy/to.js";

const tracer = trace.getTracer("discordBot");

export const botState = {
  appId: undefined as undefined | string,
};

export async function hasBridge(guildId: bigint): Promise<boolean> {
  return (await registeredBridges.get_spaceId(guildId.toString())) != undefined;
}

/**
 * getGuildContext provides context for several Discord event handlers,
 * specifically 'ready' (in backfill), 'channelCreate', 'threadCreate'
 * and 'messageCreate'.
 *
 * For a given guildId, it provides the Roomy space ID, the corresponding user
 * IDs in Roomy for each Discord ID (maybe redundant), the list of users in each
 * space and their roles, and a handle to the persisted store of latest messages
 * for each channel.
 *
 * we may want to implement some caching since Jazz was handling that
 *
 */
export async function getGuildContext(guildId: bigint): Promise<GuildContext> {
  const spaceId = await registeredBridges.get_spaceId(guildId.toString());
  if (!spaceId)
    throw new Error(
      "Discord guild doesn't have Roomy space bridged: " + guildId.toString(),
    );
  const syncedIds = syncedIdsForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  // const space = await RoomyEntity.load(spaceId);
  // if (!space) throw new Error("Could not load space ID");
  // const groups = await getSpaceGroups(space);
  const latestMessagesInChannel = discordLatestMessageInChannelForBridge({
    roomySpaceId: spaceId,
    discordGuildId: guildId,
  });
  return { guildId, syncedIds, latestMessagesInChannel };
}

/**
 * A single instance of `bot` handles all events incoming from Discord across multiple guilds.
 * The event handlers route each event to Roomy spaces as defined in the persisted mapping.
 */
export async function startBot() {
  const bot = createBot({
    token: DISCORD_TOKEN,
    intents: Intents.MessageContent | Intents.Guilds | Intents.GuildMessages,
    desiredProperties,
    events: {
      ready(ready) {
        console.log("Discord bot connected", ready);
        tracer.startActiveSpan("botReady", (span) => {
          span.setAttribute(
            "discordApplicationId",
            ready.applicationId.toString(),
          );
          span.setAttribute("shardId", ready.shardId);

          // Set Discord app ID used in `/info` API endpoint.
          botState.appId = ready.applicationId.toString();

          // Update discord slash commands.
          bot.helpers.upsertGlobalApplicationCommands(slashCommands);

          // Backfill messages sent while the bridge was offline
          backfill(bot, ready.guilds);
        });
      },

      // Handle slash commands
      async interactionCreate(interaction) {
        console.log("Interaction create event", interaction.data);
        await handleSlashCommandInteraction(interaction);
      },

      async channelCreate(channel) {
        if (!channel.guildId)
          throw new Error("Discord guild ID missing from channel create event");
        if (!(await hasBridge(channel.guildId!))) return;
        const ctx = await getGuildContext(channel.guildId);
        console.log("Channel create event", channel, ctx);
        // await getRoomyThreadForChannel(ctx, channel);
      },
      async threadCreate(channel) {
        if (!channel.guildId)
          throw new Error("Discord guild ID missing from thread create event");
        if (!(await hasBridge(channel.guildId!))) return;
        const ctx = await getGuildContext(channel.guildId);
        console.log("Thread create event", channel, ctx);
        // await getRoomyThreadForChannel(ctx, channel);
      },

      // Handle new messages
      async messageCreate(message) {
        // We don't handle realtime messages while we are in the middle of backfilling, otherwise we
        // might be indexing at the same time and incorrectly update the latest message seen in the
        // channel.
        // if (!doneBackfillingFromDiscord) return;
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

        const roomyThreadId = await ctx.syncedIds.get_roomyId(
          message.channelId.toString(),
        );

        console.log("Message", message, "threadId", roomyThreadId);

        if (!roomyThreadId) {
          throw new Error(
            "Discord channel for message doesn't have a roomy thread yet.",
          );
        }

        // const threadEnt = await RoomyEntity.load(roomyThreadId, {
        //   resolve: { components: { [ThreadComponent.id]: true } },
        // });
        // const thread =
        //   threadEnt &&
        //   (await ThreadComponent.load(
        //     threadEnt.components[ThreadComponent.id]!,
        //     { resolve: { timeline: true } },
        //   ));
        // if (!thread) throw new Error("Could't load Roomy thread.");

        // await syncDiscordMessageToRoomy(ctx, {
        //   discordChannelId: channelId,
        //   thread,
        //   message,
        // });

        ctx.latestMessagesInChannel.put(
          message.channelId.toString(),
          message.id.toString(),
        );
      },
    },
  });
  bot.start();
  return bot;
}

// should this be a global? or per guild?
export let doneBackfillingFromDiscord = false;

/** Bridge all past messages in a Discord guild to Roomy */
export async function backfill(bot: DiscordBot, guildIds: bigint[]) {
  await tracer.startActiveSpan("backfill", async (span) => {
    for (const guildId of guildIds) {
      if (!(await hasBridge(guildId))) continue;
      const ctx = await getGuildContext(guildId);

      await tracer.startActiveSpan(
        "backfillGuild",
        { attributes: { guildId: guildId.toString() } },
        async (span) => {
          console.log("backfilling Discord guild", guildId);
          const channels = await bot.helpers.getChannels(guildId);

          // Get all categories
          const categories = channels.filter(
            (x) => x.type == ChannelTypes.GuildCategory,
          );

          // Get all text channels
          const textChannels = channels.filter(
            (x) => x.type == ChannelTypes.GuildText,
          );

          // TODO: support announcement channels

          const activeThreads = (await bot.helpers.getActiveThreads(guildId))
            .threads;
          const archivedThreads = (
            await Promise.all(
              textChannels.map(async (x) => {
                let before;
                let threads: DiscordChannel[] = [];
                while (true) {
                  try {
                    const resp = await bot.helpers.getPublicArchivedThreads(
                      x.id,
                      {
                        before,
                      },
                    );
                    threads = [...threads, ...(resp.threads as any)];

                    if (resp.hasMore) {
                      before = parseInt(
                        resp.threads[resp.threads.length - 1]?.threadMetadata
                          ?.archiveTimestamp || "0",
                      );
                    } else {
                      break;
                    }
                  } catch (e) {
                    console.warn(
                      `Error fetching threads for channel ( this might be normal if the bot does not have access to the channel ): ${e}`,
                    );
                    break;
                  }
                }

                return threads;
              }),
            )
          ).flat();
          const allChannelsAndThreads = [
            ...textChannels,
            ...activeThreads,
            ...archivedThreads,
          ];

          for (const channel of textChannels) {
            await ensureRoomyChannelForDiscordChannel(ctx, channel);
          }

          for (const thread of [...activeThreads, ...archivedThreads]) {
            await ensureRoomyThreadForDiscordThread(ctx, thread);
          }

          await ensureRoomySidebarForCategoriesAndChannels(
            ctx,
            categories,
            textChannels,
          );

          for (const channel of allChannelsAndThreads) {
            await tracer.startActiveSpan(
              "backfillChannel",
              { attributes: { channelId: channel.id.toString() } },
              async (span) => {
                const cachedLatestForChannel =
                  await ctx.latestMessagesInChannel.get(channel.id.toString());

                let after = cachedLatestForChannel
                  ? BigInt(cachedLatestForChannel)
                  : "0";

                // while (true) {
                //   try {
                //     // Get the next set of messages
                //     const messages = await bot.helpers.getMessages(channel.id, {
                //       after,
                //       limit: 100,
                //     });
                //     if (messages.length > 0)
                //       span.addEvent("Fetched new messages", {
                //         count: messages.length,
                //       });

                //     console.log(
                //       `    Found ${messages.length} messages since last message.`,
                //     );

                //     if (messages.length == 0) break;

                //     // const { thread } = await getRoomyThreadForChannel(
                //     //   ctx,
                //     //   channel,
                //     // );

                //     // Backfill each one that we haven't indexed yet
                //     for (const message of messages.reverse()) {
                //       console.log("message", message.content);
                //       // after = message.id;
                //       // await syncDiscordMessageToRoomy(ctx, {
                //       //   discordChannelId: message.channelId,
                //       //   message,
                //       //   thread,
                //       // });
                //     }

                //     after &&
                //       (await ctx.latestMessagesInChannel.put(
                //         channel.id.toString(),
                //         after.toString(),
                //       ));
                //   } catch (e) {
                //     console.warn(
                //       `Error syncing message to roomy ( this might be normal if the bot does not have access to the channel ): ${e}`,
                //     );
                //     break;
                //   }
                // }

                span.end();
              },
            );
          }

          span.end();
        },
      );
    }

    span.end();
    doneBackfillingFromDiscord = true;
  });
}
