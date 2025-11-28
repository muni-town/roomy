// // import {
// //   AuthorComponent,
// //   ChildrenComponent,
// //   getComponent,
// //   CommonMarkContentComponent,
// //   RoomyAccount,
// //   RoomyEntity,
// //   ThreadComponent,
// // } from "@roomy-chat/sdk";
// import {
//   BidirectionalSublevelMap,
//   discordWebhookTokensForBridge,
//   registeredBridges,
//   syncedIdsForBridge,
// } from "../db.js";
// import type { DiscordBot, DiscordChannel } from "../discord/bot";
// import { GuildContext } from "../types.js";

// export async function startRoomyWatcher(discordBot: DiscordBot) {
//   for (const { guildId, spaceId } of await registeredBridges.list()) {
//     const syncedIds = syncedIdsForBridge({
//       discordGuildId: BigInt(guildId),
//       roomySpaceId: spaceId,
//     });

//     // get the Leaf stream metadata
//     const space = await RoomyEntity.load(spaceId, {
//       resolve: {
//         components: true,
//       },
//     });
//     if (!space) {
//       console.error("Could not load space:", spaceId);
//       continue;
//     }
//     console.log("backfilling Roomy space:", space?.id);

//     // Get the rooms in the space
//     const children = await getComponent(space, ChildrenComponent, {
//       resolve: {
//         $each: {
//           components: true,
//         },
//       },
//     });
//     if (!children) {
//       console.error("Could not load threads from space:", spaceId);
//       continue;
//     }

//     for (const child of children) {
//       if (!child) continue;
//       const discordChannelId = await syncedIds.get_discordId(child.id);
//       if (!discordChannelId) continue; // Ignore non-bridged threads
//       const threadComp = await getComponent(child, ThreadComponent, {
//         resolve: { timeline: true },
//       });
//       if (!threadComp || !threadComp.timeline) continue;

//       console.log("backfilling Roomy thread:", child.id);

//       for (const message of Object.values(threadComp.timeline.perAccount)
//         .map((x) => [...x.all])
//         .flat()) {
//         await syncMessageFromRoomyToDiscord(syncedIds, discordBot, {
//           roomySpaceId: spaceId,
//           roomyMessageId: message.value,
//           discordChannel: discordChannelId,
//           discordGuild: BigInt(guildId),
//         });
//       }

//       threadComp.timeline.subscribe(async () => {
//         if (!threadComp.timeline) return;
//         // TODO: use some mechanism to avoid looping over the entire feed every time a message is
//         // sent.
//         for (const message of Object.values(threadComp.timeline.perAccount)
//           .map((x) => [...x.all])
//           .flat()) {
//           await syncMessageFromRoomyToDiscord(syncedIds, discordBot, {
//             roomySpaceId: spaceId,
//             roomyMessageId: message.value,
//             discordChannel: discordChannelId,
//             discordGuild: BigInt(guildId),
//           });
//         }
//       });
//     }
//   }
// }

// async function syncMessageFromRoomyToDiscord(
//   syncedIds: BidirectionalSublevelMap<"discordId", "roomyId">,
//   discordBot: DiscordBot,
//   opts: {
//     roomyMessageId: string;
//     roomySpaceId: string;
//     discordGuild: bigint;
//     discordChannel: bigint | string;
//   },
// ) {
//   const alreadySyncedDiscordId = await syncedIds.get_discordId(
//     opts.roomyMessageId,
//   );
//   if (alreadySyncedDiscordId) return;

//   const webhookTokens = discordWebhookTokensForBridge({
//     discordGuildId: opts.discordGuild,
//     roomySpaceId: opts.roomySpaceId,
//   });

//   const message = await RoomyEntity.load(opts.roomyMessageId, {
//     resolve: {
//       components: true,
//     },
//   });
//   if (!message) {
//     console.error("Could not load message:", opts.roomyMessageId);
//     return;
//   }

//   const contentComp = await getComponent(message, CommonMarkContentComponent);

//   let authorInfo: { username: string; avatarUrl?: string };
//   const customAuthor = await getComponent(message, AuthorComponent);
//   if (customAuthor) {
//     authorInfo = {
//       username: customAuthor.name || "[unknown]",
//       avatarUrl: customAuthor.imageUrl,
//     };
//   } else {
//     const accountId = message._edits.components?.by?.id;
//     if (!accountId) {
//       console.error("Could not fetch profile of message author");
//       return;
//     }
//     const account = await RoomyAccount.load(accountId, {
//       resolve: { profile: true },
//     });
//     if (!account) {
//       console.error("Could not fetch profile of message author");
//       return;
//     }
//     authorInfo = {
//       username: account.profile?.name || "[unknown]",
//       avatarUrl: account.profile?.imageUrl,
//     };
//   }

//   let [webhookId, webhookToken] = (
//     await webhookTokens.get(opts.discordChannel.toString())
//   )?.split(":") || [undefined, undefined];
//   if (!webhookToken || !webhookId) {
//     const webhook = await discordBot.helpers.createWebhook(
//       opts.discordChannel,
//       {
//         name: "Roomy Bridge",
//       },
//     );
//     webhookToken = webhook.token!;
//     webhookId = webhook.id.toString();
//     await webhookTokens.put(
//       opts.discordChannel.toString(),
//       `${webhookId}:${webhookToken}`,
//     );
//   }

//   if (contentComp?.content) {
//     const discordMessage = await discordBot.helpers.executeWebhook(
//       webhookId,
//       webhookToken,
//       {
//         avatarUrl: authorInfo.avatarUrl,
//         username: authorInfo.username,
//         content: contentComp?.content,
//         wait: true,
//       },
//     );

//     if (!discordMessage) {
//       console.error("Could not create Discord message");
//       return;
//     }

//     await syncedIds.register({
//       discordId: discordMessage.id.toString(),
//       roomyId: opts.roomyMessageId,
//     });
//   }
// }

// /** Get the timeline of messages in a Roomy thread corresponding to a Discord channel
//  */
// export async function getRoomyThreadForChannel(
//   ctx: GuildContext,
//   channel: DiscordChannel,
// ): Promise<{
//   // entity: co.loaded<typeof RoomyEntity>;
//   // thread: co.loaded<typeof ThreadComponent, { timeline: true }>;
// }> {
//   const existingRoomyThreadId = await ctx.syncedIds.get_roomyId(
//     channel.id.toString(),
//   );
//   // let thread: co.loaded<typeof ThreadComponent, { timeline: true }>;
//   // let entity: co.loaded<typeof RoomyEntity>;

//   if (existingRoomyThreadId) {
//     const e = await RoomyEntity.load(existingRoomyThreadId, {
//       resolve: { components: true },
//     });
//     if (!e) {
//       throw new Error(`Error loading roomy thread: ${existingRoomyThreadId}`);
//     }
//     let t =
//       e &&
//       (await getComponent(e, ThreadComponent, {
//         resolve: { timeline: true },
//       }));

//     // If there isn't a thread component, then this entity is probably a message entity and that
//     // means that this is the first message in a Discord thread. So what we do here is we add a
//     // thread component to the entity, and we add itself to it's timeline.
//     if (!t) {
//       e.name = channel.name;
//       // NOTE: unlike normal, we restrict writes to the timeline to admins, because right now
//       // syncing doesn't work from Roomy to Discord so we don't want to let anybody write to the
//       // thread from Roomy.
//       const timeline = Timeline.create([e.id], ctx.groups.admin);
//       t = await addComponent(
//         e,
//         ThreadComponent,
//         { timeline },
//         ctx.groups.admin,
//       );
//       await addComponent(e, SubThreadsComponent, [], ctx.groups.admin);
//       const allThreads = await getComponent(ctx.space, AllThreadsComponent);
//       if (allThreads) {
//         allThreads.push(e);
//       }
//       const parentRoomyId =
//         channel.parentId &&
//         (await ctx.syncedIds.get_roomyId(channel.parentId.toString()));
//       if (parentRoomyId) {
//         const parentEnt = await RoomyEntity.load(parentRoomyId);
//         const subThreads =
//           parentEnt && (await getComponent(parentEnt, SubThreadsComponent));
//         if (subThreads) {
//           subThreads.push(e);
//         }
//       }
//     }
//     thread = t as any; // Unfortunately `getComponent` doesn't handle the `resolve: { timeline: true }` right.
//     entity = e;
//   } else {
//     const { thread: t, entity: e } = await createThread(
//       channel.name || "",
//       ctx.groups,
//     );
//     thread = t;
//     entity = e;

//     if (channel.type == ChannelTypes.GuildText) {
//       await addToFolder(ctx.space, entity);
//     } else if (channel.type == ChannelTypes.PublicThread && channel.parentId) {
//       const allThreads = await getComponent(ctx.space, AllThreadsComponent);
//       if (allThreads) {
//         allThreads.push(entity);
//       }
//       const parentRoomyId = await ctx.syncedIds.get_roomyId(
//         channel.parentId.toString(),
//       );
//       if (parentRoomyId) {
//         const parentEnt = await RoomyEntity.load(parentRoomyId);
//         const subThreads =
//           parentEnt && (await getComponent(parentEnt, SubThreadsComponent));
//         if (subThreads) {
//           subThreads.push(entity);
//         }
//       }
//     }

//     await ctx.syncedIds.register({
//       discordId: channel.id.toString(),
//       roomyId: entity.id,
//     });
//   }
//   if (!thread.timeline) {
//     throw new Error(
//       `Roomy thread timeline not loaded for thread ID: ${entity.id}`,
//     );
//   }

//   return { entity, thread };
// }
