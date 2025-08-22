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
import { DISCORD_TOKEN } from "./env";
import {
  handleSlashCommandInteraction,
  slashCommands,
} from "./discordBot/slashCommands";

import {
  discordLatestMessageInChannelForBridge,
  discordWebhookTokensForBridge,
  LatestMessages,
  registeredBridges,
  SyncedIds,
  syncedIdsForBridge,
} from "./db";
import { trace } from "@opentelemetry/api";
import {
  co,
  createMessage,
  RoomyEntity,
  createThread,
  getComponent,
  ThreadComponent,
  addToFolder,
  AuthorComponent,
  getSpaceGroups,
  LoadedSpaceGroups,
  AllThreadsComponent,
  SubThreadsComponent,
  addComponent,
  Timeline,
} from "@roomy-chat/sdk";

const tracer = trace.getTracer("discordBot");

export const botState = {
  appId: undefined as undefined | string,
};

export const desiredProperties = {
  message: {
    id: true,
    guildId: true,
    content: true,
    channelId: true,
    author: true,
    webhookId: true,
  },
  guild: {
    id: true,
    channels: true,
  },
  channel: {
    id: true,
    lastMessageId: true,
    name: true,
    type: true,
    guildId: true,
    parentId: true,
  },
  user: {
    username: true,
    avatar: true,
    id: true,
    discriminator: true,
  },
  webhook: {
    id: true,
    token: true,
  },
  interaction: {
    id: true,
    type: true,
    data: true,
    token: true,
    guildId: true,
    authorizingIntegrationOwners: true,
  },
} satisfies RecursivePartial<TransformersDesiredProperties>;

export type DiscordBot = Bot<
  CompleteDesiredProperties<typeof desiredProperties>
>;
export type DiscordChannel = SetupDesiredProps<
  Channel,
  CompleteDesiredProperties<typeof desiredProperties>
>;

async function hasBridge(guildId: bigint): Promise<boolean> {
  return (await registeredBridges.get_spaceId(guildId.toString())) != undefined;
}
type GuildContext = {
  guildId: bigint;
  syncedIds: SyncedIds;
  space: co.loaded<typeof RoomyEntity>;
  groups: LoadedSpaceGroups;
  latestMessagesInChannel: LatestMessages;
};
async function getGuildContext(guildId: bigint): Promise<GuildContext> {
  const spaceId = await registeredBridges.get_spaceId(guildId.toString());
  if (!spaceId)
    throw new Error(
      "Discord guild doesn't have Roomy space bridged: " + guildId.toString(),
    );
  const syncedIds = syncedIdsForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const space = await RoomyEntity.load(spaceId);
  if (!space) throw new Error("Could not load space ID");
  const groups = await getSpaceGroups(space);
  const latestMessagesInChannel = discordLatestMessageInChannelForBridge({
    roomySpaceId: space.id,
    discordGuildId: guildId,
  });
  return { guildId, syncedIds, space, groups, latestMessagesInChannel };
}

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
        await handleSlashCommandInteraction(interaction);
      },

      async channelCreate(channel) {
        if (!channel.guildId)
          throw new Error("Discord guild ID missing from channel create event");
        if (!(await hasBridge(channel.guildId!))) return;
        const ctx = await getGuildContext(channel.guildId);
        await getRoomyThreadForChannel(ctx, channel);
      },
      async threadCreate(channel) {
        if (!channel.guildId)
          throw new Error("Discord guild ID missing from thread create event");
        if (!(await hasBridge(channel.guildId!))) return;
        const ctx = await getGuildContext(channel.guildId);
        await getRoomyThreadForChannel(ctx, channel);
      },

      // Handle new messages
      async messageCreate(message) {
        // We don't handle realtime messages while we are in the middle of backfilling, otherwise we
        // might be indexing at the same time and incorrectly update the latest message seen in the
        // channel.
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

        const roomyThreadId = await ctx.syncedIds.get_roomyId(
          message.channelId.toString(),
        );
        if (!roomyThreadId) {
          throw new Error(
            "Discord channel for message doesn't have a roomy thread yet.",
          );
        }
        const threadEnt = await RoomyEntity.load(roomyThreadId, {
          resolve: { components: { [ThreadComponent.id]: true } },
        });
        const thread =
          threadEnt &&
          (await ThreadComponent.load(
            threadEnt.components[ThreadComponent.id]!,
            { resolve: { timeline: true } },
          ));
        if (!thread) throw new Error("Could't load Roomy thread.");

        await syncDiscordMessageToRoomy(ctx, {
          discordChannelId: channelId,
          thread,
          message,
        });

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

export let doneBackfillingFromDiscord = false;

async function backfill(bot: DiscordBot, guildIds: bigint[]) {
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
          const textChannels = channels.filter(
            (x) => x.type == ChannelTypes.GuildText,
          );
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

                while (true) {
                  try {
                    // Get the next set of messages
                    const messages = await bot.helpers.getMessages(channel.id, {
                      after,
                      limit: 100,
                    });
                    if (messages.length > 0)
                      span.addEvent("Fetched new messages", {
                        count: messages.length,
                      });

                    console.log(
                      `    Found ${messages.length} messages since last message.`,
                    );

                    if (messages.length == 0) break;

                    const { thread } = await getRoomyThreadForChannel(
                      ctx,
                      channel,
                    );

                    // Backfill each one that we haven't indexed yet
                    for (const message of messages.reverse()) {
                      after = message.id;
                      await syncDiscordMessageToRoomy(ctx, {
                        discordChannelId: message.channelId,
                        message,
                        thread,
                      });
                    }

                    after &&
                      (await ctx.latestMessagesInChannel.put(
                        channel.id.toString(),
                        after.toString(),
                      ));
                  } catch (e) {
                    console.warn(
                      `Error syncing message to roomy ( this might be normal if the bot does not have access to the channel ): ${e}`,
                    );
                    break;
                  }
                }

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

async function getRoomyThreadForChannel(
  ctx: GuildContext,
  channel: DiscordChannel,
): Promise<{
  entity: co.loaded<typeof RoomyEntity>;
  thread: co.loaded<typeof ThreadComponent, { timeline: true }>;
}> {
  const existingRoomyThreadId = await ctx.syncedIds.get_roomyId(
    channel.id.toString(),
  );
  let thread: co.loaded<typeof ThreadComponent, { timeline: true }>;
  let entity: co.loaded<typeof RoomyEntity>;

  if (existingRoomyThreadId) {
    const e = await RoomyEntity.load(existingRoomyThreadId, {
      resolve: { components: true },
    });
    if (!e) {
      throw new Error(`Error loading roomy thread: ${existingRoomyThreadId}`);
    }
    let t =
      e &&
      (await getComponent(e, ThreadComponent, {
        resolve: { timeline: true },
      }));

    // If there isn't a thread component, then this entity is probably a message entity and that
    // means that this is the first message in a Discord thread. So what we do here is we add a
    // thread component to the entity, and we add itself to it's timeline.
    if (!t) {
      e.name = channel.name;
      // NOTE: unlike normal, we restrict writes to the timeline to admins, because right now
      // syncing doesn't work from Roomy to Discord so we don't want to let anybody write to the
      // thread from Roomy.
      const timeline = Timeline.create([e.id], ctx.groups.admin);
      t = await addComponent(
        e,
        ThreadComponent,
        { timeline },
        ctx.groups.admin,
      );
      await addComponent(e, SubThreadsComponent, [], ctx.groups.admin);
      const allThreads = await getComponent(ctx.space, AllThreadsComponent);
      if (allThreads) {
        allThreads.push(e);
      }
      const parentRoomyId =
        channel.parentId &&
        (await ctx.syncedIds.get_roomyId(channel.parentId.toString()));
      if (parentRoomyId) {
        const parentEnt = await RoomyEntity.load(parentRoomyId);
        const subThreads =
          parentEnt && (await getComponent(parentEnt, SubThreadsComponent));
        if (subThreads) {
          subThreads.push(e);
        }
      }
    }
    thread = t as any; // Unfortunately `getComponent` doesn't handle the `resolve: { timeline: true }` right.
    entity = e;
  } else {
    const { thread: t, entity: e } = await createThread(
      channel.name || "",
      ctx.groups,
    );
    thread = t;
    entity = e;

    if (channel.type == ChannelTypes.GuildText) {
      await addToFolder(ctx.space, entity);
    } else if (channel.type == ChannelTypes.PublicThread && channel.parentId) {
      const allThreads = await getComponent(ctx.space, AllThreadsComponent);
      if (allThreads) {
        allThreads.push(entity);
      }
      const parentRoomyId = await ctx.syncedIds.get_roomyId(
        channel.parentId.toString(),
      );
      if (parentRoomyId) {
        const parentEnt = await RoomyEntity.load(parentRoomyId);
        const subThreads =
          parentEnt && (await getComponent(parentEnt, SubThreadsComponent));
        if (subThreads) {
          subThreads.push(entity);
        }
      }
    }

    await ctx.syncedIds.register({
      discordId: channel.id.toString(),
      roomyId: entity.id,
    });
  }
  if (!thread.timeline) {
    throw new Error(
      `Roomy thread timeline not loaded for thread ID: ${entity.id}`,
    );
  }

  return { entity, thread };
}

async function syncDiscordMessageToRoomy(
  ctx: GuildContext,
  opts: {
    discordChannelId: bigint;
    message: SetupDesiredProps<
      Message,
      CompleteDesiredProperties<NoInfer<typeof desiredProperties>>
    >;
    thread: co.loaded<typeof ThreadComponent, { timeline: true }>;
  },
) {
  await tracer.startActiveSpan("syncDiscordMessageToRoomy", async (span) => {
    // Skip messages sent by this bot
    const webhookTokens = discordWebhookTokensForBridge({
      discordGuildId: ctx.guildId,
      roomySpaceId: ctx.space.id,
    });
    const channelWebhookId = (
      await webhookTokens.get(opts.discordChannelId.toString())
    )?.split(":")[0];
    if (
      channelWebhookId &&
      opts.message.webhookId?.toString() == channelWebhookId
    ) {
      return;
    }

    // Skip if the message is already synced
    const existingRoomyMessageId = await ctx.syncedIds.get_roomyId(
      opts.message.id.toString(),
    );
    if (existingRoomyMessageId) {
      span.addEvent("messageAlreadySynced", {
        discordMessageId: opts.message.id.toString(),
        roomyMessageId: existingRoomyMessageId,
      });
      console.info("message already sent", opts);
      return;
    }

    const { entity: message } = await createMessage(
      opts.message.content,
      ctx.groups.admin,
      {
        created: new Date(opts.message.timestamp),
        // TODO: include Discord edited timestamp maybe
        updated: new Date(opts.message.timestamp),
      },
    );

    const avatar = avatarUrl(
      opts.message.author.id,
      opts.message.author.discriminator,
      { avatar: opts.message.author.avatar },
    );

    // See if we already have a roomy author info for this user
    const roomyId = await ctx.syncedIds.get_roomyId(
      opts.message.author.id.toString(),
    );
    let authorComponentId;
    if (roomyId) {
      // Update the user avatar if necessary
      AuthorComponent.load(roomyId).then((info) => {
        if (info && info.imageUrl !== avatar) {
          info.imageUrl = avatar;
        }
      });
      authorComponentId = roomyId;
    } else {
      const authorInfo = AuthorComponent.create(
        {
          authorId: `discord:${opts.message.author.id}`,
          imageUrl: avatar,
          name: opts.message.author.username,
        },
        ctx.groups.admin,
      );
      authorComponentId = authorInfo.id;
      await ctx.syncedIds.register({
        roomyId: authorInfo.id,
        discordId: opts.message.author.id.toString(),
      });
    }

    message.components[AuthorComponent.id] = authorComponentId;

    opts.thread.timeline.push(message.id);

    await ctx.syncedIds.register({
      discordId: opts.message.id.toString(),
      roomyId: message.id,
    });

    span.end();
  });
}
