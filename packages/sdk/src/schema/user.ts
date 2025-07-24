import { co, z } from "jazz-tools";
import { createInbox, publicGroup } from "../functions/index.js";
import { MediaUploadQueue } from "./import.js";
import { RoomyEntity, RoomyEntityList } from "./index.js";

export const SpaceList = co.list(RoomyEntity);

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
  roomyInbox: co.list(InboxItem),
  bannerUrl: z.string().optional(),
  description: z.string().optional(),
  joinedDate: z.date().optional(),
  joinedSpaces: co.list(RoomyEntity),

  threadSubscriptions: co.optional(co.list(z.string())), // List of thread IDs user is subscribed to
  hiddenFeedPosts: co.optional(co.list(z.string())), // List of AT Proto URIs for hidden feed posts

  activityLog: co.record(z.string(), z.string()),
  hiddenFeedPosts: co.list(z.string()).optional(),
  hiddenFeedPostsCache: co.list(co.map({
    uri: z.string(),
    text: z.string(),
    author: z.string(),
    hiddenAt: z.date(),
  })).optional(),
});

export const RoomyRoot = co.map({
  lastRead: LastReadList,
  uploadQueue: co.optional(MediaUploadQueue),
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
          roomyInbox: createInbox(),
          joinedSpaces: RoomyEntityList.create(
            [],
            publicGroup("reader"),
          ),
          activityLog: co
            .record(z.string(), z.string())
            .create({}, publicGroup("reader")),
          joinedDate: new Date(),
          hiddenFeedPosts: co
            .list(z.string())
            .create([], publicGroup("writer")),
          hiddenFeedPostsCache: co
            .list(co.map({
              uri: z.string(),
              text: z.string(),
              author: z.string(),
              hiddenAt: z.date(),
            }))
            .create([], publicGroup("writer")),
        },
        publicGroup("reader"),
      );
    }
  });
