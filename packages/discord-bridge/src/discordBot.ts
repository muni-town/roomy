import {
  Bot,
  Channel,
  ChannelTypes,
  CompleteDesiredProperties,
  createBot,
  Intents,
  Message,
  RecursivePartial,
  SetupDesiredProps,
  TransformersDesiredProperties,
} from "@discordeno/bot";
import { DISCORD_TOKEN } from "./env";
import {
  handleSlashCommandInteraction,
  slashCommands,
} from "./discordBot/slashCommands";

import {
  discordLatestMessageInChannel,
  registeredBridges,
  syncedIds as syncedIds,
} from "./db";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  co,
  createMessage,
  RoomyEntity,
  SpacePermissionsComponent,
  z,
  createThread,
  getComponent,
  ThreadComponent,
  addToFolder,
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

type DiscordBot = Bot<CompleteDesiredProperties<typeof desiredProperties>>;

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
    },
  });
  await bot.start();
}

export let doneBackfilling = false;

async function backfill(bot: DiscordBot, guildIds: bigint[]) {
  await tracer.startActiveSpan("backfill", async (span) => {
    for (const guildId of guildIds) {
      const spaceId = await registeredBridges.get_spaceId(guildId.toString());
      if (!spaceId) continue;

      await tracer.startActiveSpan(
        "backfillGuild",
        { attributes: { guildId: guildId.toString() } },
        async (span) => {
          console.log("backfilling guild", guildId);
          const channels = await bot.helpers.getChannels(guildId);
          for (const channel of channels.filter(
            (x) => x.type == ChannelTypes.GuildText,
          )) {
            await tracer.startActiveSpan(
              "backfillChannel",
              { attributes: { channelId: channel.id.toString() } },
              async (span) => {
                const cachedLatestForChannel =
                  await discordLatestMessageInChannel.get(
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
                  for (const message of messages.reverse()) {
                    after = message.id;
                    await syncDiscordMessageToRoomy({
                      guildId,
                      channel,
                      message,
                    });
                  }

                  after &&
                    (await discordLatestMessageInChannel.put(
                      channel.id.toString(),
                      after.toString(),
                    ));
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
    doneBackfilling = true;
  });
}

async function syncDiscordMessageToRoomy(opts: {
  guildId: bigint;
  channel: SetupDesiredProps<
    Channel,
    CompleteDesiredProperties<NoInfer<typeof desiredProperties>>
  >;
  message: SetupDesiredProps<
    Message,
    CompleteDesiredProperties<NoInfer<typeof desiredProperties>>
  >;
}) {
  await tracer.startActiveSpan("syncDiscordMessageToRoomy", async (span) => {
    // Skip if the message is already synced
    const existingRoomyMessageId = await syncedIds.get_roomyId(
      opts.message.id.toString(),
    );
    if (existingRoomyMessageId) {
      span.addEvent("messageAlreadySynced", {
        discordMessageId: opts.message.id.toString(),
        roomyMessageId: existingRoomyMessageId,
      });
      return;
    }

    const spaceId = await registeredBridges.get_spaceId(
      opts.guildId.toString(),
    );
    if (!spaceId) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "registeredSpaceDoesNotExist",
      });
      return;
    }
    const space = await RoomyEntity.load(spaceId);
    if (!space) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "errorLoadingSpace",
      });
      return;
    }

    const permissions = await getComponent(space, SpacePermissionsComponent);
    if (!permissions) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "spaceMissingPermissions",
      });
      return;
    }

    const existingRoomyThreadId = await syncedIds.get_roomyId(
      opts.channel.id.toString(),
    );
    let roomyThreadComponent: co.loaded<typeof ThreadComponent>;
    let roomyThreadEntity: co.loaded<typeof RoomyEntity>;
    if (existingRoomyThreadId) {
      const ent = await RoomyEntity.load(existingRoomyThreadId);
      const thread = ent ? await getComponent(ent, ThreadComponent) : undefined;
      if (!thread || !ent) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: "errorLoadingChannel",
        });
        return;
      }
      roomyThreadComponent = thread;
      roomyThreadEntity = ent;
    } else {
      const { thread, roomyObject } = await createThread(
        opts.channel.name || "",
        permissions,
      );
      roomyThreadComponent = thread;
      roomyThreadEntity = roomyObject;
      await addToFolder(space, roomyThreadEntity);

      await syncedIds.register({
        discordId: opts.channel.id.toString(),
        roomyId: roomyObject.id,
      });
    }

    const message = await createMessage(opts.message.content, {
      permissions,
    });
    roomyThreadComponent.timeline?.push(message.id);

    await syncedIds.register({
      discordId: opts.message.id.toString(),
      roomyId: message.id,
    });

    span.end();
  });
}
