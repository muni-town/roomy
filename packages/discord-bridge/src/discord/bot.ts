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
import { tracer, setDiscordAttrs, recordError } from "../tracing.js";
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
  syncedProfilesForBridge,
  syncedReactionsForBridge,
  syncedRoomLinksForBridge,
  syncedSidebarHashForBridge,
  syncedEditsForBridge,
} from "../db.js";
import { GuildContext } from "../types.js";
import {
  ensureRoomyChannelForDiscordChannel,
  ensureRoomySidebarForCategoriesAndChannels,
  ensureRoomyThreadForDiscordThread,
  ensureRoomyMessageForDiscordMessage,
  syncDiscordReactionToRoomy,
  removeDiscordReactionFromRoomy,
  syncMessageEditToRoomy,
  getRoomKey,
} from "../roomy/to.js";
import { getConnectedSpace } from "../roomy/client.js";
import { EventBatcher } from "../roomy/batcher.js";


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
 * Returns undefined if the guild is not bridged or the space is not connected.
 *
 * we may want to implement some caching since Jazz was handling that
 *
 */
export async function getGuildContext(guildId: bigint): Promise<GuildContext | undefined> {
  const spaceId = await registeredBridges.get_spaceId(guildId.toString());
  if (!spaceId) {
    console.warn(`Discord guild ${guildId} doesn't have Roomy space bridged`);
    return undefined;
  }

  const connectedSpace = getConnectedSpace(spaceId);
  if (!connectedSpace) {
    console.warn(`Space ${spaceId} for guild ${guildId} is not connected`);
    return undefined;
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
  const syncedRoomLinks = syncedRoomLinksForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const syncedProfiles = syncedProfilesForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const syncedSidebarHash = syncedSidebarHashForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const syncedEdits = syncedEditsForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  return { guildId, spaceId, syncedIds, latestMessagesInChannel, syncedReactions, syncedRoomLinks, syncedProfiles, syncedSidebarHash, syncedEdits, connectedSpace };
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
        tracer.startActiveSpan("discord.bot.ready", (span) => {
          span.setAttribute("discord.application.id", ready.applicationId.toString());
          span.setAttribute("discord.shard.id", ready.shardId);
          span.setAttribute("discord.guilds.count", ready.guilds.length);

          // Set Discord app ID used in `/info` API endpoint.
          botState.appId = ready.applicationId.toString();
          botState.bot = bot;

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
          throw new Error("Discord guild ID missing from channel create event");
        if (!(await hasBridge(channel.guildId!))) return;
        const ctx = await getGuildContext(channel.guildId);
        if (!ctx) return;
        console.log("Channel create event", channel, ctx);
        // await getRoomyThreadForChannel(ctx, channel);
      },
      async threadCreate(channel) {
        if (!channel.guildId)
          throw new Error("Discord guild ID missing from thread create event");
        if (!(await hasBridge(channel.guildId!))) return;
        const ctx = await getGuildContext(channel.guildId);
        if (!ctx) return;
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
        if (!ctx) return;
        const roomyRoomId = await ctx.syncedIds.get_roomyId(getRoomKey(channelId));

        if (!roomyRoomId) {
          console.warn(`Discord channel ${channelId} not synced to Roomy, skipping message`);
          return;
        }

        await ensureRoomyMessageForDiscordMessage(ctx, roomyRoomId, message, bot);
        await ctx.latestMessagesInChannel.put(channelId.toString(), message.id.toString());
      },

      // Handle reaction add
      async reactionAdd(payload) {
        if (!doneBackfillingFromDiscord) return;
        if (!payload.guildId) return;
        if (!(await hasBridge(payload.guildId))) return;

        const ctx = await getGuildContext(payload.guildId);
        if (!ctx) return;
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
        if (!ctx) return;
        await removeDiscordReactionFromRoomy(ctx, {
          messageId: payload.messageId,
          channelId: payload.channelId,
          userId: payload.userId,
          emoji: payload.emoji,
        });
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

        // syncMessageEditToRoomy will skip messages not in syncedIds (including bot messages)
        await syncMessageEditToRoomy(ctx, message);
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
  const roomyRoomId = await ctx.syncedIds.get_roomyId(getRoomKey(channel.id));
  if (!roomyRoomId) {
    console.warn(`Channel ${channel.id} not synced, skipping message backfill`);
    return;
  }

  let after: bigint | string = "0";
  const cachedLatest = await ctx.latestMessagesInChannel.get(channel.id.toString());
  if (cachedLatest) {
    after = BigInt(cachedLatest);
  }

  // Use event batcher to send events in batches of 100
  const batcher = new EventBatcher(ctx.connectedSpace);

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
        await ensureRoomyMessageForDiscordMessage(ctx, roomyRoomId, message, batcher);
        after = message.id;
      }

      // Flush after each Discord API batch
      await batcher.flush();

      await ctx.latestMessagesInChannel.put(channel.id.toString(), after.toString());
    } catch (e) {
      console.warn(`Error backfilling messages for channel ${channel.id}: ${e}`);
      // Flush any remaining events before exiting
      await batcher.flush();
      break;
    }
  }

  // Final flush to ensure all events are sent
  await batcher.flush();
}

/** Bridge all past messages in a single Discord guild to Roomy */
export async function backfillGuild(bot: DiscordBot, guildId: bigint) {
  const ctx = await getGuildContext(guildId);
  if (!ctx) {
    console.warn(`Skipping backfill for guild ${guildId}: space not connected`);
    return;
  }

  await tracer.startActiveSpan(
    "bridge.guild.backfill",
    async (span) => {
      setDiscordAttrs(span, { guildId });
      span.setAttribute("roomy.space.id", ctx.spaceId);

      try {
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

        // Note: announcement channels are not yet supported

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

        span.setAttribute("discord.channels.count", textChannels.length);
        span.setAttribute("discord.threads.count", activeThreads.length + archivedThreads.length);

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
                "bridge.channel.backfill",
                async (channelSpan) => {
                  setDiscordAttrs(channelSpan, { channelId: channel.id });
                  try {
                    await backfillMessagesForChannel(bot, ctx, channel);
                  } catch (e) {
                    recordError(channelSpan, e);
                    throw e;
                  } finally {
                    channelSpan.end();
                  }
                },
              ),
            ),
          );
        }
      } catch (e) {
        recordError(span, e);
        throw e;
      } finally {
        span.end();
      }
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
