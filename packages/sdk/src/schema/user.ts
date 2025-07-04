import { co, z } from "jazz-tools";
import { Space } from "./space.ts";
import { createInbox, createSpaceList, publicGroup } from "../functions/index.ts";

export const SpaceList = co.list(Space);

export const LastReadList = co.record(z.string(), z.date());

export const InboxItem = co.map({
  spaceId: z.string(),
  objectId: z.string().optional(),

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
