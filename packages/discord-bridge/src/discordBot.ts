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
} from "@discordeno/bot";
import { DISCORD_TOKEN } from "./env";
import {
  handleSlashCommandInteraction,
  slashCommands,
} from "./discordBot/slashCommands";

import {
  discordLatestMessageInChannelForBridge,
  discordWebhookTokensForBridge,
  registeredBridges,
  syncedIdsForBridge,
} from "./db";
import { Span, SpanStatusCode, trace } from "@opentelemetry/api";
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

      // Handle new messages
      async messageCreate(message) {
        // We don't handle realtime messages while we are in the middle of backfilling, otherwise we
        // might be indexing at the same time and incorrectly update the latest message seen in the
        // channel.
        if (!doneBackfillingFromDiscord) return;

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

        const spaceId = await registeredBridges.get_spaceId(guildId.toString());
        if (!spaceId) {
          // This guild is not bridged.
          return;
        }

        const latestMessages = discordLatestMessageInChannelForBridge({
          discordGuildId: guildId,
          roomySpaceId: spaceId,
        });

        const syncedIds = syncedIdsForBridge({
          discordGuildId: guildId,
          roomySpaceId: spaceId,
        });

        // If the channel doesn't have a roomy channel created for it yet, we need to make sure we
        // fetch the channel name before syncing the message.
        let channelName: undefined | string;
        const roomyThread = await syncedIds.get_roomyId(
          message.channelId.toString(),
        );
        if (!roomyThread) {
          const channel = await bot.helpers.getChannel(message.channelId);
          channelName = channel.name;
        }

        await syncDiscordMessageToRoomy(bot, {
          guildId,
          message,
          channel: { id: message.channelId, name: channelName },
        });

        latestMessages.put(message.channelId.toString(), message.id.toString());
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
      const spaceId = await registeredBridges.get_spaceId(guildId.toString());
      if (!spaceId) continue;

      const latestMessages = discordLatestMessageInChannelForBridge({
        discordGuildId: guildId,
        roomySpaceId: spaceId,
      });

      await tracer.startActiveSpan(
        "backfillGuild",
        { attributes: { guildId: guildId.toString() } },
        async (span) => {
          console.log("backfilling Discord guild", guildId);
          const channels = await bot.helpers.getChannels(guildId);
          for (const channel of channels.filter(
            (x) => x.type == ChannelTypes.GuildText,
          )) {
            await tracer.startActiveSpan(
              "backfillChannel",
              { attributes: { channelId: channel.id.toString() } },
              async (span) => {
                const cachedLatestForChannel = await latestMessages.get(
                  channel.id.toString(),
                );

                let after = cachedLatestForChannel
                  ? BigInt(cachedLatestForChannel)
                  : "0";

                while (true) {
                  // Get the next set of messages
                  const messages = await bot.helpers.getMessages(channel.id, {
                    after,
                  });
                  if (messages.length > 0)
                    span.addEvent("Fetched new messages", {
                      count: messages.length,
                    });

                  console.log(
                    `    Found ${messages.length} messages since last message.`,
                  );

                  if (messages.length == 0) break;

                  // Backfill each one that we haven't indexed yet
                  try {
                    for (const message of messages.reverse()) {
                      after = message.id;
                      await syncDiscordMessageToRoomy(bot, {
                        guildId,
                        channel,
                        message,
                      });
                    }

                    after &&
                      (await latestMessages.put(
                        channel.id.toString(),
                        after.toString(),
                      ));
                  } catch (e) {
                    console.error(`Error syncing message to roomy: ${e}`);
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

async function syncDiscordMessageToRoomy(
  bot: DiscordBot,
  opts: {
    guildId: bigint;
    channel: { id: bigint; name?: string };
    message: SetupDesiredProps<
      Message,
      CompleteDesiredProperties<NoInfer<typeof desiredProperties>>
    >;
  },
) {
  const error = (span: Span, message: string) => {
    const error = new Error(message);
    span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
    });
    return error;
  };
  await tracer.startActiveSpan("syncDiscordMessageToRoomy", async (span) => {
    const spaceId = await registeredBridges.get_spaceId(
      opts.guildId.toString(),
    );
    if (!spaceId) {
      throw error(
        span,
        `Registered space does not exist for guild: ${opts.guildId}`,
      );
    }

    // Skip messages sent by this bot
    const webhookTokens = discordWebhookTokensForBridge({
      discordGuildId: opts.guildId,
      roomySpaceId: spaceId,
    });
    const channelWebhookId = (
      await webhookTokens.get(opts.channel.id.toString())
    )?.split(":")[0];
    if (
      channelWebhookId &&
      opts.message.webhookId?.toString() == channelWebhookId
    ) {
      return;
    }

    // Skip if the message is already synced
    const syncedIds = syncedIdsForBridge({
      discordGuildId: opts.guildId,
      roomySpaceId: spaceId,
    });
    const existingRoomyMessageId = await syncedIds.get_roomyId(
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

    const space = await RoomyEntity.load(spaceId, {
      resolve: { components: true },
    });
    if (!space) {
      throw error(span, `Error loading space: ${spaceId}`);
    }
    const groups = await getSpaceGroups(space);

    const existingRoomyThreadId = await syncedIds.get_roomyId(
      opts.channel.id.toString(),
    );
    let roomyThreadComponent: co.loaded<typeof ThreadComponent>;
    let roomyThreadEntity: co.loaded<typeof RoomyEntity>;
    if (existingRoomyThreadId) {
      const ent = await RoomyEntity.load(existingRoomyThreadId, {
        resolve: { components: true },
      });
      const thread = ent
        ? await getComponent(ent, ThreadComponent, {
            resolve: { timeline: true },
          })
        : undefined;
      if (!thread || !ent) {
        throw error(
          span,
          `Error loading roomy thread: ${existingRoomyThreadId}`,
        );
      }
      roomyThreadComponent = thread;
      roomyThreadEntity = ent;
    } else {
      const { thread, entity } = await createThread(
        opts.channel.name || "",
        groups,
      );
      roomyThreadComponent = thread;
      roomyThreadEntity = entity;
      await addToFolder(space, roomyThreadEntity);

      await syncedIds.register({
        discordId: opts.channel.id.toString(),
        roomyId: entity.id,
      });
    }
    if (!roomyThreadComponent.timeline) {
      throw error(
        span,
        `Roomy thread timeline not loaded for thread ID: ${roomyThreadEntity.id}`,
      );
    }

    const { entity: message } = await createMessage(
      opts.message.content,
      groups.admin,
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
    const roomyId = await syncedIds.get_roomyId(
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
        groups.admin,
      );
      authorComponentId = authorInfo.id;
      syncedIds.register({
        roomyId: authorInfo.id,
        discordId: opts.message.author.id.toString(),
      });
    }

    message.components[AuthorComponent.id] = authorComponentId;

    roomyThreadComponent.timeline.push(message.id);

    await syncedIds.register({
      discordId: opts.message.id.toString(),
      roomyId: message.id,
    });

    span.end();
  });
}
