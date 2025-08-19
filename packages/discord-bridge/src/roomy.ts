import {
  AuthorComponent,
  ChildrenComponent,
  getComponent,
  PlainTextContentComponent,
  RoomyAccount,
  RoomyEntity,
  RoomyProfile,
  ThreadComponent,
} from "@roomy-chat/sdk";
import {
  BidirectionalSublevelMap,
  discordWebhookTokensForBridge,
  registeredBridges,
  syncedIdsForBridge,
} from "./db";
import type { DiscordBot } from "./discordBot";

export async function startRoomyWatcher(discordBot: DiscordBot) {
  for (const { guildId, spaceId } of await registeredBridges.list()) {
    const syncedIds = syncedIdsForBridge({
      discordGuildId: BigInt(guildId),
      roomySpaceId: spaceId,
    });
    const space = await RoomyEntity.load(spaceId, {
      resolve: {
        components: true,
      },
    });
    if (!space) {
      console.error("Could not load space:", spaceId);
      continue;
    }
    console.log("backfilling Roomy space:", space?.id);
    const children = await getComponent(space, ChildrenComponent, {
      resolve: {
        $each: {
          components: true,
        },
      },
    });
    if (!children) {
      console.error("Could not load threads from space:", spaceId);
      continue;
    }

    for (const child of children) {
      if (!child) continue;
      const discordChannelId = await syncedIds.get_discordId(child.id);
      if (!discordChannelId) continue; // Ignore non-bridged threads
      const threadComp = await getComponent(child, ThreadComponent, {
        resolve: { timeline: true },
      });
      if (!threadComp || !threadComp.timeline) continue;

      console.log("backfilling Roomy thread:", child.id);

      for (const message of Object.values(threadComp.timeline.perAccount)
        .map((x) => [...x.all])
        .flat()) {
        await syncMessageFromRoomyToDiscord(syncedIds, discordBot, {
          roomySpaceId: spaceId,
          roomyMessageId: message.value,
          discordChannel: discordChannelId,
          discordGuild: BigInt(guildId),
        });
      }

      threadComp.timeline.subscribe(async () => {
        if (!threadComp.timeline) return;
        // TODO: use some mechanism to avoid looping over the entire feed every time a message is
        // sent.
        for (const message of Object.values(threadComp.timeline.perAccount)
          .map((x) => [...x.all])
          .flat()) {
          await syncMessageFromRoomyToDiscord(syncedIds, discordBot, {
            roomySpaceId: spaceId,
            roomyMessageId: message.value,
            discordChannel: discordChannelId,
            discordGuild: BigInt(guildId),
          });
        }
      });
    }
  }
}

async function syncMessageFromRoomyToDiscord(
  syncedIds: BidirectionalSublevelMap<"discordId", "roomyId">,
  discordBot: DiscordBot,
  opts: {
    roomyMessageId: string;
    roomySpaceId: string;
    discordGuild: bigint;
    discordChannel: bigint | string;
  },
) {
  const alreadySyncedDiscordId = await syncedIds.get_discordId(
    opts.roomyMessageId,
  );
  if (alreadySyncedDiscordId) return;

  const webhookTokens = discordWebhookTokensForBridge({
    discordGuildId: opts.discordGuild,
    roomySpaceId: opts.roomySpaceId,
  });

  const message = await RoomyEntity.load(opts.roomyMessageId, {
    resolve: {
      components: true,
    },
  });
  if (!message) {
    console.error("Could not load message:", opts.roomyMessageId);
    return;
  }

  const contentComp = await getComponent(message, PlainTextContentComponent);

  let authorInfo: { username: string; avatarUrl?: string };
  const customAuthor = await getComponent(message, AuthorComponent);
  if (customAuthor) {
    authorInfo = {
      username: customAuthor.name || "[unknown]",
      avatarUrl: customAuthor.imageUrl,
    };
  } else {
    const accountId = message._edits.components?.by?.id;
    if (!accountId) {
      console.error("Could not fetch profile of message author");
      return;
    }
    const account = await RoomyAccount.load(accountId, {
      resolve: { profile: true },
    });
    if (!account) {
      console.error("Could not fetch profile of message author");
      return;
    }
    authorInfo = {
      username: account.profile?.name || "[unknown]",
      avatarUrl: account.profile?.imageUrl,
    };
  }

  let [webhookId, webhookToken] = (
    await webhookTokens.get(opts.discordChannel.toString())
  )?.split(":") || [undefined, undefined];
  if (!webhookToken || !webhookId) {
    const webhook = await discordBot.helpers.createWebhook(
      opts.discordChannel,
      {
        name: "Roomy Bridge",
      },
    );
    webhookToken = webhook.token!;
    webhookId = webhook.id.toString();
    await webhookTokens.put(
      opts.discordChannel.toString(),
      `${webhookId}:${webhookToken}`,
    );
  }

  if (contentComp?.content) {
    const discordMessage = await discordBot.helpers.executeWebhook(
      webhookId,
      webhookToken,
      {
        avatarUrl: authorInfo.avatarUrl,
        username: authorInfo.username,
        content: contentComp?.content,
        wait: true,
      },
    );

    if (!discordMessage) {
      console.error("Could not create Discord message");
      return;
    }

    await syncedIds.register({
      discordId: discordMessage.id.toString(),
      roomyId: opts.roomyMessageId,
    });
  }
}
