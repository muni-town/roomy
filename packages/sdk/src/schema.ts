import { co, z } from "jazz-tools";
import { createInbox, createSpaceList, publicGroup } from "./utils.js";

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

// Voting system for globally hiding feed posts
export const FeedPostVote = co.map({
  postUri: z.string(), // AT Proto URI of the post
  userId: z.string(), // User who voted to hide
  reason: z.string().optional(), // Optional reason for hiding (spam, irrelevant, etc.)
  votedAt: z.date(),
});

export const GlobalHiddenPost = co.map({
  postUri: z.string(), // AT Proto URI of the post
  votes: co.list(FeedPostVote), // List of votes to hide this post
  threshold: z.number(), // Number of votes needed to globally hide
  isHidden: z.boolean(), // Whether post is globally hidden
  hiddenAt: z.date().optional(), // When it was globally hidden
});

export const Channel = co.map({
  name: z.string(),

  mainThread: Thread,

  subThreads: co.list(Thread),

  pages: z.optional(co.list(Page)),

  softDeleted: z.boolean().optional(),

  // Channel type - determines how the channel behaves
  channelType: z.enum(["chat", "feeds", "links"]).optional(),

  // ATProto feed integration - now used for feeds channels
  isAtprotoFeed: z.boolean().optional(), // For backwards compatibility
  showAtprotoFeeds: z.boolean().optional(), // Show feeds in board view
  atprotoFeedsConfig: z.optional(
    z.object({
      feeds: z.array(z.string()), // Which feeds to show
      threadsOnly: z.boolean(), // Only show thread posts
    }),
  ),

  // Global hiding system for feed channels
  globalHiddenPosts: z.optional(co.list(GlobalHiddenPost)),
  hideThreshold: z.number().optional(), // Number of votes needed to globally hide
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
  threadSubscriptions: z.optional(co.list(z.string())), // List of thread IDs user is subscribed to
  hiddenFeedPosts: z.optional(co.list(z.string())), // List of AT Proto URIs for hidden feed posts
  hiddenFeedPostsCache: z.optional(
    co.list(
      co.map({
        uri: z.string(),
        text: z.string(),
        author: z.string(),
        hiddenAt: z.date(),
      }),
    ),
  ), // Cache of hidden post data for better UI display
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
          name: creationProps?.name ?? "Anonymous",
          joinedSpaces: createSpaceList(),
          roomyInbox: createInbox(),
        },
        publicGroup("reader"),
      );
    }
  });

export const SpaceMigrationReference = co.record(z.string(), z.string());
export const IDList = co.list(z.string());