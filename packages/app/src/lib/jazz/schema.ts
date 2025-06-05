import { co, z } from "jazz-tools";
import { getRandomUsername } from "./username.ts";
import { createSpaceList, publicGroup } from "./utils.ts";

export const Reaction = co.map({
  emoji: z.string(),
});

export const ReactionList = co.list(Reaction);

export const MovedTo = co.map({
  thread: z.string(),
});

export const Message = co.map({
  content: co.richText(),

  createdAt: z.date(),
  updatedAt: z.date(),

  replyTo: z.string().optional(),
  movedTo: z.optional(MovedTo),
  reactions: ReactionList,
  type: z.enum(["message", "announcement"]),

  softDeleted: z.boolean().optional(),
});

export const Timeline = co.feed(z.string());

export const Thread = co.map({
  name: z.string(),
  timeline: Timeline,

  softDeleted: z.boolean().optional(),
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
});


export const Category = co.map({
  name: z.string(),
  channels: z.optional(co.list(Channel)),
  softDeleted: z.boolean().optional(),
});

export const Space = co.map({
  name: z.string(),
  image: co.image().optional(),

  imageUrl: z.string().optional(),

  channels: co.list(Channel),

  categories: co.list(Category),

  description: z.string().optional(),
  emoji: z.string().optional(),

  members: co.list(co.account()),

  version: z.number().optional(),
  adminId: z.string(),

  threads: co.list(Thread),
  pages: co.list(Page),

  bans: co.list(z.string()),
});

export const SpaceList = co.list(Space);

export const RoomyProfile = co.profile({
  name: z.string(),
  imageUrl: z.string().optional(),
  blueskyHandle: z.string().optional(),
  joinedSpaces: SpaceList,
});

export const LastReadList = co.record(z.string(), z.date());

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
        },
        publicGroup("reader"),
      );
    }
  });
