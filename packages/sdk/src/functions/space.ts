import { Account, co, Group, z } from "jazz-tools";
import { allSpacesListId } from "../ids.js";
import { IDList, RoomyObject, Space } from "../schema/index.js";
import { createThread } from "./thread.js";
import { publicGroup } from "./group.js";
import { addToFolder, createFolder } from "./folder.js";

export function createSpace(
  name: string,
  description?: string,
  createDefaultChannel: boolean = true,
) {
  // user is already admin
  const adminGroup = Group.create();

  const readerGroup = Group.create();
  // add reading for everyone
  readerGroup.addMember("everyone", "reader");
  readerGroup.addMember(adminGroup);

  const publicWriteGroup = publicGroup("writer");

  const rootFolder = createFolder("root", adminGroup);

  const threads = co.feed(RoomyObject).create([], publicWriteGroup);

  if (createDefaultChannel) {
    const thread = createThread("general", adminGroup);

    threads.push(thread.roomyObject);
    addToFolder(rootFolder, thread.roomyObject);
  }

  const space = Space.create(
    {
      name,
      description,
      members: co
        .list(co.account())
        .create([Account.getMe()], publicWriteGroup),
      version: 2,
      creatorId: Account.getMe().id,
      adminGroupId: adminGroup.id,
      
      rootFolder,

      threads,
      pages: co.list(RoomyObject).create([], publicWriteGroup),
      folders: co.list(RoomyObject).create([], publicWriteGroup),

      bans: co.list(z.string()).create([], readerGroup),
    },
    readerGroup,
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
