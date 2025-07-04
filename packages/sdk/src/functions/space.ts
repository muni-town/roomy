import { Account, co, Group, z } from "jazz-tools";
import { allSpacesListId } from "../ids.ts";
import { IDList, RoomyObject, Space } from "../schema/index.ts";
import { createRoomyObject } from "./roomyobject.ts";
import { createThread } from "./thread.ts";
import { publicGroup } from "./group.ts";

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
  readerGroup.extend(adminGroup);

  const publicWriteGroup = publicGroup("writer");

  const thread = createDefaultChannel ? createThread("general", adminGroup) : undefined;

  const rootFolder = createRoomyObject("root", "folder", adminGroup);

  const threads = co.list(RoomyObject).create([], publicWriteGroup);

  if (thread) {
    threads.push(thread.roomyObject);

    rootFolder.childrenIds.push(thread.roomyObject.id);
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
      pages: co.list(RoomyObject).create([], readerGroup),
      folders: co.list(RoomyObject).create([], readerGroup),

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
