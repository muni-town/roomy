import { co, z, Account, CoMapSchema, CoListSchema, CoList } from 'jazz-tools';
import { publicGroup } from './utils.js';

export const Reaction = co.map({
  emoji: z.string(),
});

export const ReactionList = co.list(Reaction);

export const ImageUrlEmbed = co.map({
  url: z.string(),
});

export const VideoUrlEmbed = co.map({
  url: z.string(),
});

export const Embed = co.map({
  type: z.enum(['imageUrl', 'videoUrl']),
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

  softDeleted: co.optional(z.boolean()),
});

export const Category = co.map({
  name: z.string(),
  channels: z.optional(co.list(Channel)),
  softDeleted: z.boolean().optional(),
});

export const Space: CoMapSchema<{
  name: z.z.ZodString;
  imageUrl: z.ZodOptional<z.z.ZodString>;
  description: z.ZodOptional<z.z.ZodString>;
  channels: ChannelList;
  categories: CoListSchema<typeof Category>;
  members: CoListSchema<any>;
  version: z.ZodOptional<z.z.ZodNumber>;
  creatorId: z.z.ZodString;
  adminGroupId: z.z.ZodString;
  threads: CoListSchema<typeof Thread>;
  pages: CoListSchema<typeof Page>;
  bans: CoListSchema<z.z.ZodString>;
}> = co.map({
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

export type ChannelList = CoListSchema<typeof Channel>;

export type SpaceListSchema = CoListSchema<typeof Space>;
export type SpaceList = CoList<typeof Space._output>;

export const SpaceList: SpaceListSchema = co.list(Space);

export const LastReadList = co.record(z.string(), z.date());

export const InboxItem = co.map({
  spaceId: z.string(),
  channelId: z.string().optional(),
  threadId: z.string().optional(),

  messageId: z.string(),

  read: z.boolean().optional(),

  type: z.enum(['reply', 'mention']),
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

function getRandomUsername(): string {
  const adjectives = [
    'happy',
    'clever',
    'bright',
    'swift',
    'bold',
    'kind',
    'wise',
    'cool',
  ];
  const nouns = ['cat', 'dog', 'bird', 'fish', 'bear', 'wolf', 'fox', 'deer'];

  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const number = Math.floor(Math.random() * 1000);

  return `${adjective}-${noun}-${number}`;
}

export const RoomyAccount = co
  .account({
    profile: RoomyProfile,
    root: RoomyRoot,
  })
  .withMigration((account: Account, creationProps?: { name: string }) => {
    console.log('Migrating RoomyAccount');
    try {
      if (account.root === undefined) {
        account.root = RoomyRoot.create({
          lastRead: LastReadList.create({}),
        });
      }

      if (!account.profile || !('joinedSpaces' in account.profile)) {
        account.profile = RoomyProfile.create(
          {
            name: creationProps?.name ?? getRandomUsername(),
            joinedSpaces: SpaceList.create([]),
            roomyInbox: co.list(InboxItem).create([]),
          },
          publicGroup('reader')
        );
      }
    } catch (error) {
      console.error('Error migrating RoomyAccount:', error);
    }

    console.log('Migrating RoomyAccount done');
  });

export const SpaceMigrationReference = co.record(z.string(), z.string());
export const IDList = co.list(z.string());
