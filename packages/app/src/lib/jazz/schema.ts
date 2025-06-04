import { co, z } from "jazz-tools";
import { getRandomUsername } from "./username.ts";
import { createSpaceList, publicGroup } from "./utils.ts";

export const Reaction = co.map({
  emoji: z.string(),
});

export const Message = co.map({
  content: co.richText(),

  createdAt: z.date(),
  updatedAt: z.date(),

  replyTo: z.string().optional(),
  reactions: co.list(Reaction),
  type: z.enum(["message", "announcement"]),

  thread: z.string().optional(),

  softDeleted: z.boolean().optional(),
});

export const Timeline = co.feed(z.string());

export const Thread = co.map({
  name: z.string(),
  timeline: Timeline,
});

export const Channel = co.map({
  name: z.string(),

  mainThread: Thread,
  subThreads: co.list(Thread),
});

export const Space = co.map({
  name: z.string(),
  image: co.image().optional(),
  channels: co.list(Channel),
  description: z.string().optional(),
  emoji: z.string().optional(),
  members: co.list(co.account()),
  version: z.number().optional(),
  adminId: z.string(),
});

export const SpaceList = co.list(Space);

export const RoomyProfile = co.profile({
  name: z.string(),
  image: co.image().optional(),
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
