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

import { avatarUrl, type Emoji } from "@discordeno/bot";
import { ChannelProperties, MessageProperties } from "../discord/types";
import { GuildContext } from "../types";
import {
  newUlid,
  toBytes,
  UserDid,
  type Attachment,
  type Did,
  type Event,
  type Ulid,
} from "@roomy/sdk";
import {
  discordWebhookTokensForBridge,
  syncedProfilesForBridge,
} from "../db.js";
import {
  tracer,
  setDiscordAttrs,
  setRoomyAttrs,
  recordError,
} from "../tracing.js";
import { EventBatcher } from "./batcher.js";

// const tracer = trace.getTracer("discordBot");

/**
 * Compute a simple hash from Discord user profile data.
 * Used for change detection to avoid redundant profile updates.
 */
function computeProfileHash(
  username: string,
  globalName: string | null,
  avatar: string | null,
): string {
  const data = `${username}|${globalName ?? ""}|${avatar ?? ""}`;
  // Simple hash: base64 encode and take first 16 chars
  return Buffer.from(data).toString("base64").slice(0, 16);
}

/**
 * Ensure a Discord user's profile is synced to Roomy.
 * Uses hash-based change detection to avoid redundant updates.
 * @param batcher - Optional event batcher for bulk operations
 */
export async function ensureRoomyProfileForDiscordUser(
  ctx: GuildContext,
  user: {
    id: bigint;
    username: string;
    discriminator: string;
    globalName?: string | null;
    avatar?: string | null;
  },
  batcher?: EventBatcher,
): Promise<void> {
  return tracer.startActiveSpan(
    "sync.profile.discord_to_roomy",
    async (span) => {
      try {
        // Set Discord attributes
        setDiscordAttrs(span, {
          guildId: ctx.guildId,
          userId: user.id,
        });
        span.setAttribute("discord.user.name", user.username);

        // Set Roomy attributes
        setRoomyAttrs(span, {
          spaceId: ctx.spaceId,
        });

        const syncedProfiles = syncedProfilesForBridge({
          discordGuildId: ctx.guildId,
          roomySpaceId: ctx.spaceId,
        });

        const userIdStr = user.id.toString();
        const hash = computeProfileHash(
          user.username,
          user.globalName ?? null,
          user.avatar ?? null,
        );

        // Check if profile already synced with same hash
        try {
          const existingHash = await syncedProfiles.get(userIdStr);
          if (existingHash === hash) {
            span.setAttribute("sync.reason", "no_change");
            span.setAttribute("sync.result", "skipped_no_change");
            return; // No change
          }
          span.setAttribute("sync.reason", "profile_changed");
        } catch {
          // Key not found - first sync for this user
          span.setAttribute("sync.reason", "new_user");
        }

        // Build avatar URL using discordeno helper (handles format and size correctly)
        const userAvatarUrl = avatarUrl(user.id, user.discriminator, {
          avatar: user.avatar ?? undefined,
          size: 256,
          format: "webp",
        });

        // Send profile update event
        const event: Event = {
          id: newUlid(),
          $type: "space.roomy.user.updateProfile.v0",
          did: `did:discord:${userIdStr}` as Did,
          name: user.globalName ?? user.username,
          avatar: userAvatarUrl,
          extensions: {
            "space.roomy.extension.discordUserOrigin.v0": {
              $type: "space.roomy.extension.discordUserOrigin.v0",
              snowflake: userIdStr,
              guildId: ctx.guildId.toString(),
              profileHash: hash,
              handle: user.username,
            },
          },
        };

        if (batcher) {
          await batcher.add(event);
        } else {
          await ctx.connectedSpace.sendEvent(event);
        }
        console.log(
          `Synced profile for Discord user ${user.username} (${userIdStr})`,
        );

        // Update local cache
        await syncedProfiles.put(userIdStr, hash);

        span.setAttribute("sync.result", "success");
      } catch (error) {
        span.setAttribute("sync.result", "error");
        recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export async function ensureRoomyChannelForDiscordChannel(
  ctx: GuildContext,
  channel: ChannelProperties,
): Promise<string> {
  // Check if already synced
  const existingRoomyId = await ctx.syncedIds.get_roomyId(
    channel.id.toString(),
  );
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
  console.log(
    `Created Roomy channel ${roomId} for Discord channel ${channel.name}`,
  );

  // Register the mapping immediately (subscription handler will also do this, but we need it now)
  try {
    await ctx.syncedIds.register({
      discordId: channel.id.toString(),
      roomyId: roomId,
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("already registered")) {
      // Another process (subscription handler) registered this mapping - use the existing one
      const existingRoomyId = await ctx.syncedIds.get_roomyId(
        channel.id.toString(),
      );
      if (existingRoomyId) {
        console.log(
          `Channel ${channel.name} was registered by another process as ${existingRoomyId}`,
        );
        return existingRoomyId;
      }
    }
    throw e;
  }

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
      console.warn(
        `Channel ${channel.name} not synced yet, skipping in sidebar`,
      );
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
  const parentRoomyId = await ctx.syncedIds.get_roomyId(
    thread.parentId.toString(),
  );
  if (!parentRoomyId) {
    throw new Error(
      `Parent channel ${thread.parentId} not synced yet for thread ${thread.name}`,
    );
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
  console.log(
    `Created Roomy thread ${roomId} for Discord thread ${thread.name}, linked to ${parentRoomyId}`,
  );

  // Register the mapping immediately
  try {
    await ctx.syncedIds.register({
      discordId: thread.id.toString(),
      roomyId: roomId,
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("already registered")) {
      // Another process (subscription handler) registered this mapping - use the existing one
      const existingRoomyId = await ctx.syncedIds.get_roomyId(
        thread.id.toString(),
      );
      if (existingRoomyId) {
        console.log(
          `Thread ${thread.name} was registered by another process as ${existingRoomyId}`,
        );
        return existingRoomyId;
      }
    }
    throw e;
  }

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
  batcher?: EventBatcher,
): Promise<string | null> {
  return tracer.startActiveSpan(
    "sync.message.discord_to_roomy",
    async (span) => {
      try {
        // Set Discord attributes
        setDiscordAttrs(span, {
          guildId: ctx.guildId,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.author.id,
        });

        // Set Roomy attributes
        setRoomyAttrs(span, {
          spaceId: ctx.spaceId,
          roomId: roomyRoomId,
        });

        // 1. Idempotency check
        const existingId = await ctx.syncedIds.get_roomyId(
          message.id.toString(),
        );
        if (existingId) {
          span.setAttribute("sync.result", "skipped_already_synced");
          return existingId;
        }

        // 1b. Ensure user profile is synced
        await tracer.startActiveSpan("sync.user.ensure", async (userSpan) => {
          try {
            setDiscordAttrs(userSpan, { userId: message.author.id });
            await ensureRoomyProfileForDiscordUser(
              ctx,
              {
                id: message.author.id,
                username: message.author.username,
                discriminator: message.author.discriminator,
                globalName: (message.author as any).globalName ?? null,
                avatar:
                  (message.author.avatar as unknown as string | null) ?? null,
              },
              batcher,
            );
          } catch (error) {
            recordError(userSpan, error);
            throw error;
          } finally {
            userSpan.end();
          }
        });

        // 2. Skip bot's own webhook messages (avoid echo)
        const webhookTokens = discordWebhookTokensForBridge({
          discordGuildId: ctx.guildId,
          roomySpaceId: ctx.spaceId,
        });
        const channelWebhookToken = await webhookTokens.get(
          message.channelId.toString(),
        );
        const channelWebhookId = channelWebhookToken?.split(":")[0];
        if (
          channelWebhookId &&
          message.webhookId?.toString() === channelWebhookId
        ) {
          span.setAttribute("sync.result", "skipped_own_webhook");
          return null;
        }

        // 3. Build attachments array
        const attachments: Attachment[] = [];

        // 3a. Reply attachment (if message_reference exists and target is synced)
        if (message.messageReference?.messageId) {
          const targetIdStr = message.messageReference.messageId.toString();
          const replyTargetId = await ctx.syncedIds.get_roomyId(targetIdStr);
          if (replyTargetId) {
            attachments.push({
              $type: "space.roomy.attachment.reply.v0",
              target: replyTargetId as Ulid,
            });
          } else {
            // Target message not synced yet - this can happen for cross-channel replies
            // or if messages arrive out of order
            console.warn(
              `Reply target ${message.messageReference.messageId} not found for message ${message.id}. ` +
                `The reply attachment will be missing.`,
            );
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

        // Send message event with tracing
        await tracer.startActiveSpan("sync.message.send", async (sendSpan) => {
          try {
            setRoomyAttrs(sendSpan, { eventId: messageId });
            if (batcher) {
              await batcher.add(event);
            } else {
              await ctx.connectedSpace.sendEvent(event);
            }
            console.log(
              `Created Roomy message ${messageId} for Discord message ${message.id}`,
            );
          } catch (error) {
            recordError(sendSpan, error);
            throw error;
          } finally {
            sendSpan.end();
          }
        });

        // 5. Register mapping immediately with tracing
        await tracer.startActiveSpan(
          "sync.mapping.store",
          async (mappingSpan) => {
            try {
              mappingSpan.setAttribute(
                "sync.mapping.discord_id",
                message.id.toString(),
              );
              mappingSpan.setAttribute("sync.mapping.roomy_id", messageId);
              await ctx.syncedIds.register({
                discordId: message.id.toString(),
                roomyId: messageId,
              });
            } catch (e) {
              if (
                e instanceof Error &&
                e.message.includes("already registered")
              ) {
                // Another process (subscription handler) registered this mapping - use the existing one
                mappingSpan.setAttribute("sync.mapping.conflict", true);
                const existingRoomyId = await ctx.syncedIds.get_roomyId(
                  message.id.toString(),
                );
                if (existingRoomyId) {
                  console.log(
                    `Message ${message.id} was registered by another process as ${existingRoomyId}`,
                  );
                  mappingSpan.end();
                  span.setAttribute("sync.result", "success");
                  return existingRoomyId;
                }
              }
              recordError(mappingSpan, e);
              throw e;
            } finally {
              mappingSpan.end();
            }
          },
        );

        span.setAttribute("sync.result", "success");
        return messageId;
      } catch (error) {
        span.setAttribute("sync.result", "error");
        recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Convert Discord emoji to a string representation for Roomy.
 * Custom emojis use their ID, unicode emojis use their name.
 */
function emojiToString(emoji: Partial<Emoji>): string {
  // Custom emoji - use the format <:name:id> or <a:name:id> for animated
  if (emoji.id) {
    const animated = emoji.animated ? "a" : "";
    return `<${animated}:${emoji.name || "_"}:${emoji.id}>`;
  }
  // Unicode emoji - just use the name (which is the emoji character)
  return emoji.name || "❓";
}

/**
 * Generate a unique key for a reaction (for idempotency tracking).
 */
function reactionKey(
  messageId: bigint,
  userId: bigint,
  emoji: Partial<Emoji>,
): string {
  const emojiKey = emoji.id ? emoji.id.toString() : emoji.name || "unknown";
  return `${messageId}:${userId}:${emojiKey}`;
}

/**
 * Sync a Discord reaction to Roomy as a bridged reaction.
 */
export async function syncDiscordReactionToRoomy(
  ctx: GuildContext,
  opts: {
    messageId: bigint;
    channelId: bigint;
    userId: bigint;
    emoji: Partial<Emoji>;
  },
): Promise<string | null> {
  return tracer.startActiveSpan(
    "sync.reaction.discord_to_roomy",
    async (span) => {
      try {
        // Set Discord attributes
        setDiscordAttrs(span, {
          guildId: ctx.guildId,
          channelId: opts.channelId,
          messageId: opts.messageId,
          userId: opts.userId,
        });

        // Set action and emoji attributes
        span.setAttribute("sync.action", "add");
        const reactionString = emojiToString(opts.emoji);
        span.setAttribute("discord.emoji", reactionString);

        const key = reactionKey(opts.messageId, opts.userId, opts.emoji);

        // 1. Idempotency check - skip if already synced
        try {
          const existingReactionId = await ctx.syncedReactions.get(key);
          if (existingReactionId) {
            span.setAttribute("sync.result", "skipped_already_synced");
            return existingReactionId;
          }
        } catch {
          // Key not found - proceed with sync
        }

        // 2. Get the Roomy message ID for this Discord message
        const roomyMessageId = await tracer.startActiveSpan(
          "sync.mapping.lookup",
          async (lookupSpan) => {
            try {
              lookupSpan.setAttribute("sync.mapping.type", "message");
              lookupSpan.setAttribute(
                "sync.mapping.discord_id",
                opts.messageId.toString(),
              );
              const id = await ctx.syncedIds.get_roomyId(
                opts.messageId.toString(),
              );
              if (id) {
                lookupSpan.setAttribute("sync.mapping.roomy_id", id);
              }
              return id;
            } finally {
              lookupSpan.end();
            }
          },
        );

        if (!roomyMessageId) {
          span.setAttribute("sync.result", "skipped_message_not_synced");
          console.warn(
            `Discord message ${opts.messageId} not synced to Roomy, skipping reaction`,
          );
          return null;
        }

        // Set Roomy attributes now that we have the message ID
        setRoomyAttrs(span, {
          spaceId: ctx.spaceId,
        });

        // 3. Get the Roomy room ID for this channel
        const roomyRoomId = await ctx.syncedIds.get_roomyId(
          opts.channelId.toString(),
        );
        if (!roomyRoomId) {
          span.setAttribute("sync.result", "skipped_channel_not_synced");
          console.warn(
            `Discord channel ${opts.channelId} not synced to Roomy, skipping reaction`,
          );
          return null;
        }

        setRoomyAttrs(span, { roomId: roomyRoomId });

        // 4. Build and send the AddBridgedReaction event
        const reactionId = newUlid();

        const event: Event = {
          id: reactionId,
          room: roomyRoomId as Ulid,
          $type: "space.roomy.reaction.addBridgedReaction.v0",
          reactionTo: roomyMessageId as Ulid,
          reaction: reactionString,
          reactingUser: UserDid.assert(`did:discord:${opts.userId}`),
        };

        await tracer.startActiveSpan("sync.reaction.send", async (sendSpan) => {
          try {
            setRoomyAttrs(sendSpan, { eventId: reactionId });
            await ctx.connectedSpace.sendEvent(event);
            console.log(
              `Synced reaction ${reactionString} from Discord user ${opts.userId} to message ${roomyMessageId}`,
            );
          } catch (error) {
            recordError(sendSpan, error);
            throw error;
          } finally {
            sendSpan.end();
          }
        });

        // 5. Track the synced reaction
        await ctx.syncedReactions.put(key, reactionId);

        span.setAttribute("sync.result", "success");
        return reactionId;
      } catch (error) {
        span.setAttribute("sync.result", "error");
        recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Remove a Discord reaction from Roomy.
 */
export async function removeDiscordReactionFromRoomy(
  ctx: GuildContext,
  opts: {
    messageId: bigint;
    channelId: bigint;
    userId: bigint;
    emoji: Partial<Emoji>;
  },
): Promise<void> {
  return tracer.startActiveSpan(
    "sync.reaction.discord_to_roomy",
    async (span) => {
      try {
        // Set Discord attributes
        setDiscordAttrs(span, {
          guildId: ctx.guildId,
          channelId: opts.channelId,
          messageId: opts.messageId,
          userId: opts.userId,
        });

        // Set action and emoji attributes
        span.setAttribute("sync.action", "remove");
        const emojiStr = emojiToString(opts.emoji);
        span.setAttribute("discord.emoji", emojiStr);

        const key = reactionKey(opts.messageId, opts.userId, opts.emoji);

        // 1. Get the Roomy reaction event ID
        let reactionEventId: string | undefined;
        try {
          reactionEventId = await ctx.syncedReactions.get(key);
        } catch {
          // Key not found - reaction wasn't synced
          span.setAttribute("sync.result", "skipped_not_found");
          console.warn(`Reaction not found for removal: ${key}`);
          return;
        }

        if (!reactionEventId) {
          span.setAttribute("sync.result", "skipped_not_found");
          console.warn(`Reaction not found for removal: ${key}`);
          return;
        }

        // 2. Get the Roomy room ID for this channel
        const roomyRoomId = await ctx.syncedIds.get_roomyId(
          opts.channelId.toString(),
        );
        if (!roomyRoomId) {
          span.setAttribute("sync.result", "skipped_channel_not_synced");
          console.warn(
            `Discord channel ${opts.channelId} not synced to Roomy, skipping reaction removal`,
          );
          return;
        }

        // Set Roomy attributes
        setRoomyAttrs(span, {
          spaceId: ctx.spaceId,
          roomId: roomyRoomId,
        });

        // 3. Send the RemoveBridgedReaction event
        const eventId = newUlid();
        const event: Event = {
          id: eventId,
          room: roomyRoomId as Ulid,
          $type: "space.roomy.reaction.removeBridgedReaction.v0",
          reactionId: reactionEventId as Ulid,
          reactingUser: UserDid.assert(`did:discord:${opts.userId}`),
        };

        await tracer.startActiveSpan("sync.reaction.send", async (sendSpan) => {
          try {
            setRoomyAttrs(sendSpan, { eventId });
            await ctx.connectedSpace.sendEvent(event);
            console.log(
              `Removed reaction ${reactionEventId} from Discord user ${opts.userId}`,
            );
          } catch (error) {
            recordError(sendSpan, error);
            throw error;
          } finally {
            sendSpan.end();
          }
        });

        // 4. Remove from tracking
        await ctx.syncedReactions.del(key);

        span.setAttribute("sync.result", "success");
      } catch (error) {
        span.setAttribute("sync.result", "error");
        recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
