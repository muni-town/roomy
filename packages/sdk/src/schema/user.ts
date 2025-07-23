import { co, z } from "jazz-tools";
import { Space } from "./space.js";
import {
  createInbox,
  createSpaceList,
  publicGroup,
} from "../functions/index.js";
import { RoomyEntity, RoomyEntityList } from "./index.js";

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
  joinedDate: z.date().optional(),
  newJoinedSpacesTest: co.list(RoomyEntity),

  activityLog: co.record(z.string(), z.string()),
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
          newJoinedSpacesTest: RoomyEntityList.create(
            [],
            publicGroup("reader"),
          ),
          activityLog: co
            .record(z.string(), z.string())
            .create({}, publicGroup("reader")),
          joinedDate: new Date(),
        },
        publicGroup("reader"),
      );
    }
  });
