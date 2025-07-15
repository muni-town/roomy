import { Account, co, Group, z } from "jazz-tools";
import { allSpacesListId } from "../ids.ts";
import { IDList, RoomyObject, Space } from "../schema/index.ts";
import { createThread } from "./thread.ts";
import { publicInvitableWriteGroup } from "./group.ts";
import { addToFolder, createFolder } from "./folder.ts";

export function createSpace(
  name: string,
  description?: string,
  opts?: {
    createDefaultChannel?: boolean;
    everyoneCanRead?: boolean;
  },
) {
  // user is already admin
  const spaceAdminGroup = Group.create();
  const spaceMemberGroup = publicInvitableWriteGroup({
    everyoneCanRead: false,
  });
  spaceMemberGroup.addMember(spaceAdminGroup, "admin");

  const spaceGroup = Group.create();
  spaceGroup.addMember(spaceAdminGroup, "admin");
  spaceGroup.addMember(spaceMemberGroup, "reader");
  if (opts?.everyoneCanRead) {
    spaceGroup.addMember("everyone", "reader");
  }

  const rootFolder = createFolder("root", spaceAdminGroup);

  const threads = co.feed(RoomyObject).create([], spaceMemberGroup);

  if (opts?.createDefaultChannel) {
    const thread = createThread("general", spaceAdminGroup);

    threads.push(thread.roomyObject);
    addToFolder(rootFolder, thread.roomyObject);
  }

  const space = Space.create(
    {
      name,
      description,
      members: co
        .list(co.account())
        .create([Account.getMe()], spaceMemberGroup),
      version: 2,
      creatorId: Account.getMe().id,
      adminGroupId: spaceAdminGroup.id,
      memberGroupId: spaceMemberGroup.id,

      rootFolder,

      threads,
      pages: co.list(RoomyObject).create([], spaceMemberGroup),
      folders: co.list(RoomyObject).create([], spaceMemberGroup),

      bans: co.list(z.string()).create([], spaceGroup),
    },
    spaceGroup,
  );

  addToAllSpacesList(space.id);

  return space;
}

export async function addToAllSpacesList(spaceId: string) {
  const allSpacesList = await IDList.load(allSpacesListId);
  if (!allSpacesList) return;
  allSpacesList.push(spaceId);
}

export function isSpaceAdmin(
  space: co.loaded<typeof Space> | undefined | null,
) {
  if (!space) return false;

  try {
    const me = Account.getMe();
    return me.canAdmin(space);
  } catch (error) {
    return false;
  }
}

export function joinSpace(space: co.loaded<typeof Space>) {
  space.members?.push(Account.getMe());
}
