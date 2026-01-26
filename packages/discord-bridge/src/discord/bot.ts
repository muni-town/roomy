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
import type { Emoji } from "@discordeno/bot";

import {
  discordLatestMessageInChannelForBridge,
  discordWebhookTokensForBridge,
  LatestMessages,
  registeredBridges,
  SyncedIds,
  syncedIdsForBridge,
  syncedReactionsForBridge,
} from "../db.js";
import { GuildContext } from "../types.js";
import {
  ensureRoomyChannelForDiscordChannel,
  ensureRoomySidebarForCategoriesAndChannels,
  ensureRoomyThreadForDiscordThread,
  ensureRoomyMessageForDiscordMessage,
  syncDiscordReactionToRoomy,
  removeDiscordReactionFromRoomy,
} from "../roomy/to.js";
import { getConnectedSpace } from "../roomy/client.js";

const tracer = trace.getTracer("discordBot");

export const botState = {
  appId: undefined as undefined | string,
  bot: undefined as DiscordBot | undefined,
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

  const connectedSpace = getConnectedSpace(spaceId);
  if (!connectedSpace) {
    throw new Error(
      "Space not connected: " + spaceId,
    );
  }

  const syncedIds = syncedIdsForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const latestMessagesInChannel = discordLatestMessageInChannelForBridge({
    roomySpaceId: spaceId,
    discordGuildId: guildId,
  });
  const syncedReactions = syncedReactionsForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  return { guildId, spaceId, syncedIds, latestMessagesInChannel, syncedReactions, connectedSpace };
}

/**
 * A single instance of `bot` handles all events incoming from Discord across multiple guilds.
 * The event handlers route each event to Roomy spaces as defined in the persisted mapping.
 */
export async function startBot() {
  const bot = createBot({
    token: DISCORD_TOKEN,
    intents: Intents.MessageContent | Intents.Guilds | Intents.GuildMessages | Intents.GuildMessageReactions,
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
          botState.bot = bot;

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
        const roomyRoomId = await ctx.syncedIds.get_roomyId(channelId.toString());

        if (!roomyRoomId) {
          console.warn(`Discord channel ${channelId} not synced to Roomy, skipping message`);
          return;
        }

        await ensureRoomyMessageForDiscordMessage(ctx, roomyRoomId, message);
        await ctx.latestMessagesInChannel.put(channelId.toString(), message.id.toString());
      },

      // Handle reaction add
      async reactionAdd(payload) {
        if (!doneBackfillingFromDiscord) return;
        if (!payload.guildId) return;
        if (!(await hasBridge(payload.guildId))) return;

        const ctx = await getGuildContext(payload.guildId);
        await syncDiscordReactionToRoomy(ctx, {
          messageId: payload.messageId,
          channelId: payload.channelId,
          userId: payload.userId,
          emoji: payload.emoji,
        });
      },

      // Handle reaction remove
      async reactionRemove(payload) {
        if (!doneBackfillingFromDiscord) return;
        if (!payload.guildId) return;
        if (!(await hasBridge(payload.guildId))) return;

        const ctx = await getGuildContext(payload.guildId);
        await removeDiscordReactionFromRoomy(ctx, {
          messageId: payload.messageId,
          channelId: payload.channelId,
          userId: payload.userId,
          emoji: payload.emoji,
        });
      },
    },
  });
  bot.start();
  return bot;
}

// should this be a global? or per guild?
export let doneBackfillingFromDiscord = false;

async function backfillMessagesForChannel(
  bot: DiscordBot,
  ctx: GuildContext,
  channel: DiscordChannel,
): Promise<void> {
  const roomyRoomId = await ctx.syncedIds.get_roomyId(channel.id.toString());
  if (!roomyRoomId) {
    console.warn(`Channel ${channel.id} not synced, skipping message backfill`);
    return;
  }

  let after: bigint | string = "0";
  const cachedLatest = await ctx.latestMessagesInChannel.get(channel.id.toString());
  if (cachedLatest) {
    after = BigInt(cachedLatest);
  }

  while (true) {
    try {
      const messages = await bot.helpers.getMessages(channel.id, {
        after,
        limit: 100,
      });

      if (messages.length === 0) break;

      console.log(`Backfilling ${messages.length} messages in channel ${channel.name || channel.id}`);

      // Process oldest first (messages come newest-first from API)
      const sortedMessages = [...messages].reverse();
      for (const message of sortedMessages) {
        await ensureRoomyMessageForDiscordMessage(ctx, roomyRoomId, message);
        after = message.id;
      }

      await ctx.latestMessagesInChannel.put(channel.id.toString(), after.toString());
    } catch (e) {
      console.warn(`Error backfilling messages for channel ${channel.id}: ${e}`);
      break;
    }
  }
}

/** Bridge all past messages in a single Discord guild to Roomy */
export async function backfillGuild(bot: DiscordBot, guildId: bigint) {
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

      // Backfill messages for all channels in parallel (with concurrency limit)
      const CONCURRENCY_LIMIT = 5;
      const channelChunks: DiscordChannel[][] = [];
      for (let i = 0; i < allChannelsAndThreads.length; i += CONCURRENCY_LIMIT) {
        channelChunks.push(allChannelsAndThreads.slice(i, i + CONCURRENCY_LIMIT));
      }

      for (const chunk of channelChunks) {
        await Promise.all(
          chunk.map((channel) =>
            tracer.startActiveSpan(
              "backfillChannelMessages",
              { attributes: { channelId: channel.id.toString() } },
              async (span) => {
                await backfillMessagesForChannel(bot, ctx, channel);
                span.end();
              },
            ),
          ),
        );
      }

      span.end();
    },
  );
}

/** Bridge all past messages in multiple Discord guilds to Roomy */
export async function backfill(bot: DiscordBot, guildIds: bigint[]) {
  await tracer.startActiveSpan("backfill", async (span) => {
    for (const guildId of guildIds) {
      if (!(await hasBridge(guildId))) continue;
      await backfillGuild(bot, guildId);
    }

    span.end();
    doneBackfillingFromDiscord = true;
  });
}
