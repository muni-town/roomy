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

import { ChannelProperties, MessageProperties } from "../discord/types";
import { GuildContext } from "../types";
import { newUlid, toBytes, type Attachment, type Event, type Ulid } from "@roomy/sdk";
import { discordWebhookTokensForBridge } from "../db.js";

// const tracer = trace.getTracer("discordBot");

export async function ensureRoomyChannelForDiscordChannel(
  ctx: GuildContext,
  channel: ChannelProperties,
): Promise<string> {
  // Check if already synced
  const existingRoomyId = await ctx.syncedIds.get_roomyId(channel.id.toString());
  if (existingRoomyId) {
    console.log(`Channel ${channel.name} already synced as ${existingRoomyId}`);
    return existingRoomyId;
  }

  // Create new room
  const roomId = newUlid();
  const event: Event = {
    id: roomId,
    $type: "space.roomy.room.createRoom.v0",
    kind: "space.roomy.channel",
    name: channel.name || "Untitled",
    extensions: {
      "space.roomy.extension.discordOrigin.v0": {
        snowflake: channel.id.toString(),
        guildId: ctx.guildId.toString(),
      },
    },
  };

  await ctx.connectedSpace.sendEvent(event);
  console.log(`Created Roomy channel ${roomId} for Discord channel ${channel.name}`);

  // Register the mapping immediately (subscription handler will also do this, but we need it now)
  await ctx.syncedIds.register({
    discordId: channel.id.toString(),
    roomyId: roomId,
  });

  return roomId;
}

export async function ensureRoomySidebarForCategoriesAndChannels(
  ctx: GuildContext,
  categories: ChannelProperties[],
  textChannels: ChannelProperties[],
): Promise<void> {
  // Build category map: categoryId -> roomyIds of child channels
  const categoryChildren = new Map<string, Ulid[]>();
  const uncategorizedChannels: Ulid[] = [];

  for (const channel of textChannels) {
    const roomyId = await ctx.syncedIds.get_roomyId(channel.id.toString());
    if (!roomyId) {
      console.warn(`Channel ${channel.name} not synced yet, skipping in sidebar`);
      continue;
    }

    if (channel.parentId) {
      const parentIdStr = channel.parentId.toString();
      if (!categoryChildren.has(parentIdStr)) {
        categoryChildren.set(parentIdStr, []);
      }
      categoryChildren.get(parentIdStr)!.push(roomyId as Ulid);
    } else {
      uncategorizedChannels.push(roomyId as Ulid);
    }
  }

  // Build categories array for UpdateSidebar event
  const sidebarCategories: { name: string; children: Ulid[] }[] = [];

  // Add uncategorized channels to "general" category
  if (uncategorizedChannels.length > 0) {
    sidebarCategories.push({
      name: "general",
      children: uncategorizedChannels,
    });
  }

  // Add each Discord category (skip empty ones)
  for (const category of categories) {
    const children = categoryChildren.get(category.id.toString()) || [];
    if (children.length > 0) {
      sidebarCategories.push({
        name: category.name || "Unnamed Category",
        children,
      });
    }
  }

  // Send UpdateSidebar event
  const event: Event = {
    id: newUlid(),
    $type: "space.roomy.space.updateSidebar.v0",
    categories: sidebarCategories,
  };

  await ctx.connectedSpace.sendEvent(event);
  console.log(`Updated sidebar with ${sidebarCategories.length} categories`);
}

export async function ensureRoomyThreadForDiscordThread(
  ctx: GuildContext,
  thread: ChannelProperties,
): Promise<string> {
  // Check if already synced
  const existingRoomyId = await ctx.syncedIds.get_roomyId(thread.id.toString());
  if (existingRoomyId) {
    console.log(`Thread ${thread.name} already synced as ${existingRoomyId}`);
    return existingRoomyId;
  }

  // Get parent channel's Roomy ID
  if (!thread.parentId) {
    throw new Error(`Thread ${thread.name} has no parent channel`);
  }
  const parentRoomyId = await ctx.syncedIds.get_roomyId(thread.parentId.toString());
  if (!parentRoomyId) {
    throw new Error(`Parent channel ${thread.parentId} not synced yet for thread ${thread.name}`);
  }

  // Create new room for thread
  const roomId = newUlid();
  const createRoomEvent: Event = {
    id: roomId,
    $type: "space.roomy.room.createRoom.v0",
    kind: "space.roomy.thread",
    name: thread.name || "Untitled Thread",
    extensions: {
      "space.roomy.extension.discordOrigin.v0": {
        snowflake: thread.id.toString(),
        guildId: ctx.guildId.toString(),
      },
    },
  };

  await ctx.connectedSpace.sendEvent(createRoomEvent);

  // Link thread to parent channel
  const linkEvent: Event = {
    id: newUlid(),
    room: parentRoomyId as Ulid,
    $type: "space.roomy.link.createRoomLink.v0",
    linkToRoom: roomId,
    isCreationLink: true,
  };

  await ctx.connectedSpace.sendEvent(linkEvent);
  console.log(`Created Roomy thread ${roomId} for Discord thread ${thread.name}, linked to ${parentRoomyId}`);

  // Register the mapping immediately
  await ctx.syncedIds.register({
    discordId: thread.id.toString(),
    roomyId: roomId,
  });

  return roomId;
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

export async function ensureRoomyMessageForDiscordMessage(
  ctx: GuildContext,
  roomyRoomId: string,
  message: MessageProperties,
): Promise<string | null> {
  // 1. Idempotency check
  const existingId = await ctx.syncedIds.get_roomyId(message.id.toString());
  if (existingId) {
    return existingId;
  }

  // 2. Skip bot's own webhook messages (avoid echo)
  const webhookTokens = discordWebhookTokensForBridge({
    discordGuildId: ctx.guildId,
    roomySpaceId: ctx.spaceId,
  });
  const channelWebhookToken = await webhookTokens.get(message.channelId.toString());
  const channelWebhookId = channelWebhookToken?.split(":")[0];
  if (channelWebhookId && message.webhookId?.toString() === channelWebhookId) {
    return null;
  }

  // 3. Build attachments array
  const attachments: Attachment[] = [];

  // 3a. Reply attachment (if message_reference exists and target is synced)
  if (message.messageReference?.messageId) {
    const replyTargetId = await ctx.syncedIds.get_roomyId(
      message.messageReference.messageId.toString(),
    );
    if (replyTargetId) {
      attachments.push({
        $type: "space.roomy.attachment.reply.v0",
        target: replyTargetId as Ulid,
      });
    }
  }

  // 3b. Media attachments (images, videos, files)
  for (const att of message.attachments || []) {
    if (att.contentType?.startsWith("image/")) {
      attachments.push({
        $type: "space.roomy.attachment.image.v0",
        uri: att.url,
        mimeType: att.contentType,
        width: att.width,
        height: att.height,
        size: att.size,
      });
    } else if (att.contentType?.startsWith("video/")) {
      attachments.push({
        $type: "space.roomy.attachment.video.v0",
        uri: att.url,
        mimeType: att.contentType,
        width: att.width,
        height: att.height,
        size: att.size,
      });
    } else {
      attachments.push({
        $type: "space.roomy.attachment.file.v0",
        uri: att.url,
        mimeType: att.contentType || "application/octet-stream",
        name: att.filename,
        size: att.size,
      });
    }
  }

  // 4. Build CreateMessage event
  const messageId = newUlid();
  const extensions: Record<string, unknown> = {
    "space.roomy.extension.discordMessageOrigin.v0": {
      $type: "space.roomy.extension.discordMessageOrigin.v0",
      snowflake: message.id.toString(),
      channelId: message.channelId.toString(),
      guildId: ctx.guildId.toString(),
    },
    "space.roomy.extension.authorOverride.v0": {
      $type: "space.roomy.extension.authorOverride.v0",
      did: `did:discord:${message.author.id}`,
    },
    "space.roomy.extension.timestampOverride.v0": {
      $type: "space.roomy.extension.timestampOverride.v0",
      timestamp: new Date(message.timestamp).getTime(),
    },
  };

  if (attachments.length > 0) {
    extensions["space.roomy.extension.attachments.v0"] = {
      $type: "space.roomy.extension.attachments.v0",
      attachments,
    };
  }

  const event: Event = {
    id: messageId,
    room: roomyRoomId as Ulid,
    $type: "space.roomy.message.createMessage.v0",
    body: {
      mimeType: "text/markdown",
      data: toBytes(new TextEncoder().encode(message.content)),
    },
    extensions,
  };

  await ctx.connectedSpace.sendEvent(event);
  console.log(`Created Roomy message ${messageId} for Discord message ${message.id}`);

  // 5. Register mapping immediately
  await ctx.syncedIds.register({
    discordId: message.id.toString(),
    roomyId: messageId,
  });

  return messageId;
}
