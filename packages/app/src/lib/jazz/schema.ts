import { co, z } from "jazz-tools";
import { getRandomUsername } from "./username.ts";
import { createInbox, createSpaceList, publicGroup } from "./utils.ts";

export const Reaction = co.map({
  emoji: z.string(),
});

export const ReactionList = co.list(Reaction);

export const ImageUrlEmbed = co.map({
  url: z.string(),
});

export const Embed = co.map({
  type: z.enum(["imageUrl"]),
  embedId: z.string(),
});

export const Message = co.map({
  content: z.string(),

  createdAt: z.date(),
  updatedAt: z.date(),

  hiddenIn: co.list(z.string()),

  replyTo: z.string().optional(),
  reactions: ReactionList,

  softDeleted: z.boolean().optional(),

  embeds: z.optional(co.list(Embed)),

  author: z.string().optional(),

  threadId: z.string().optional(),
});

export const Timeline = co.feed(z.string());

export const Thread = co.map({
  name: z.string(),
  timeline: Timeline,

  softDeleted: z.boolean().optional(),

  channelId: z.string(),
});

export const Page = co.map({
  name: z.string(),
  softDeleted: z.boolean().optional(),
  body: z.string(),
});

export const Channel = co.map({
  name: z.string(),

  mainThread: Thread,

  subThreads: co.list(Thread),

  pages: z.optional(co.list(Page)),

  softDeleted: z.boolean().optional(),
  
  // ATProto feed integration for board view
  showAtprotoFeeds: z.boolean().optional(), // Show feeds in board view
  atprotoFeedsConfig: z.optional(z.object({
    feeds: z.array(z.string()), // Which feeds to show
    threadsOnly: z.boolean(), // Only show thread posts
  })),
});

export const Category = co.map({
  name: z.string(),
  channels: z.optional(co.list(Channel)),
  softDeleted: z.boolean().optional(),
});

export const Space = co.map({
  name: z.string(),

  imageUrl: z.string().optional(),

  channels: co.list(Channel),

  categories: co.list(Category),

  description: z.string().optional(),

  members: co.list(co.account()),

  version: z.number().optional(),
  creatorId: z.string(),

  adminGroupId: z.string(),

  threads: co.list(Thread),
  pages: co.list(Page),

  bans: co.list(z.string()),
});

export const SpaceList = co.list(Space);

export const LastReadList = co.record(z.string(), z.date());

export const InboxItem = co.map({
  spaceId: z.string(),
  channelId: z.string().optional(),
  threadId: z.string().optional(),

  messageId: z.string(),

  read: z.boolean().optional(),

  type: z.enum(["reply", "mention"]),
});

export const RoomyProfile = co.profile({
  name: z.string(),
  imageUrl: z.string().optional(),
  blueskyHandle: z.string().optional(),
  joinedSpaces: SpaceList,
  roomyInbox: co.list(InboxItem),
  bannerUrl: z.string().optional(),
  description: z.string().optional(),
});

export const RoomyRoot = co.map({
  lastRead: LastReadList,
});

export const RoomyAccount = co
  .account({
    profile: RoomyProfile,
    root: RoomyRoot,
  })
  .withMigration((account, creationProps?: { name: string }) => {
    if (account.root === undefined) {
      account.root = RoomyRoot.create({
        lastRead: LastReadList.create({}),
      });
    }

    if (account.profile === undefined) {
      account.profile = RoomyProfile.create(
        {
          name: creationProps?.name ?? getRandomUsername(),
          joinedSpaces: createSpaceList(),
          roomyInbox: createInbox(),
        },
        publicGroup("reader"),
      );
    }
  });

export const SpaceMigrationReference = co.record(z.string(), z.string());
export const IDList = co.list(z.string());