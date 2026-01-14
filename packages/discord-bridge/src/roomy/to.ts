// import { trace } from "@opentelemetry/api";
// import {
//   desiredProperties,
//   DiscordBot,
//   DiscordChannel,
//   getGuildContext,
//   hasBridge,
// } from "../discord/bot";
// import {
//   ChannelTypes,
//   CompleteDesiredProperties,
//   Message,
//   SetupDesiredProps,
// } from "@discordeno/bot";
// import { discordWebhookTokensForBridge } from "../db";
// import { getRoomyThreadForChannel } from "./from";

import { ChannelProperties } from "../discord/types";
import { GuildContext } from "../types";

// const tracer = trace.getTracer("discordBot");

export async function ensureRoomyChannelForDiscordChannel(
  ctx: GuildContext,
  channel: ChannelProperties,
) {
  console.log("TODO: Ensure Roomy Channel for", channel.name);

  // first check what channels exist in Roomy
}

export async function ensureRoomySidebarForCategoriesAndChannels(
  ctx: GuildContext,
  categories: ChannelProperties[],
  textChannels: ChannelProperties[],
) {
  console.log(
    "TODO: Ensure Roomy Sidebar for categories and channels",
    categories.map((c) => c.name),
  );

  // note: do not create empty categories
}

export async function ensureRoomyThreadForDiscordThread(
  ctx: GuildContext,
  thread: ChannelProperties,
) {
  console.log("TODO: Ensure Roomy Thread for", thread.name);
}

// export async function syncDiscordMessageToRoomy(
//   ctx: GuildContext,
//   opts: {
//     discordChannelId: bigint;
//     message: SetupDesiredProps<
//       Message,
//       CompleteDesiredProperties<NoInfer<typeof desiredProperties>>
//     >;
//     thread: co.loaded<typeof ThreadComponent, { timeline: true }>;
//   },
// ) {
//   await tracer.startActiveSpan("syncDiscordMessageToRoomy", async (span) => {
//     // Skip messages sent by this bot
//     const webhookTokens = discordWebhookTokensForBridge({
//       discordGuildId: ctx.guildId,
//       roomySpaceId: ctx.space.id,
//     });
//     const channelWebhookId = (
//       await webhookTokens.get(opts.discordChannelId.toString())
//     )?.split(":")[0];
//     if (
//       channelWebhookId &&
//       opts.message.webhookId?.toString() == channelWebhookId
//     ) {
//       return;
//     }

//     // Skip if the message is already synced
//     const existingRoomyMessageId = await ctx.syncedIds.get_roomyId(
//       opts.message.id.toString(),
//     );
//     if (existingRoomyMessageId) {
//       span.addEvent("messageAlreadySynced", {
//         discordMessageId: opts.message.id.toString(),
//         roomyMessageId: existingRoomyMessageId,
//       });
//       console.info("message already sent", opts);
//       return;
//     }

//     const { entity: message } = await createMessage(
//       opts.message.content,
//       ctx.groups.admin,
//       {
//         created: new Date(opts.message.timestamp),
//         // TODO: include Discord edited timestamp maybe
//         updated: new Date(opts.message.timestamp),
//       },
//     );

//     const avatar = avatarUrl(
//       opts.message.author.id,
//       opts.message.author.discriminator,
//       { avatar: opts.message.author.avatar },
//     );

//     // See if we already have a roomy author info for this user
//     const roomyId = await ctx.syncedIds.get_roomyId(
//       opts.message.author.id.toString(),
//     );
//     let authorComponentId;

//     if (roomyId) {
//       // Update the user avatar if necessary
//       AuthorComponent.load(roomyId).then((info) => {
//         if (info && info.imageUrl !== avatar) {
//           info.imageUrl = avatar;
//         }
//       });
//       authorComponentId = roomyId;
//     } else {
//       const authorInfo = AuthorComponent.create(
//         {
//           authorId: `discord:${opts.message.author.id}`,
//           imageUrl: avatar,
//           name: opts.message.author.username,
//         },
//         ctx.groups.admin,
//       );
//       authorComponentId = authorInfo.id;
//       await ctx.syncedIds.register({
//         roomyId: authorInfo.id,
//         discordId: opts.message.author.id.toString(),
//       });
//     }

//     message.components[AuthorComponent.id] = authorComponentId;

//     opts.thread.timeline.push(message.id);

//     await ctx.syncedIds.register({
//       discordId: opts.message.id.toString(),
//       roomyId: message.id,
//     });

//     span.end();
//   });
// }
