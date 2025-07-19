import { Account, co, Group } from "jazz-tools";
import { allSpacesListId } from "../ids.js";
import { AllFoldersComponent, AllMembersComponent, AllPagesComponent, AllPermissions, AllThreadsComponent, BansComponent, IDList, MemberEntry, RoomyEntity, Space, SpacePermissionsComponent } from "../schema/index.js";
import { createThread } from "./thread.js";
import { addToFolder } from "./folder.js";
import { createRoomyObject } from "./roomyobject.js";
import { createPermissions } from "./permissions.js";
import { ChildrenComponent } from "../schema/folder.js";

export async function createSpace(
  name: string,
  description?: string,
  createDefaultChannel: boolean = true,
) {
  const permissions = createPermissions();

  const publicGroupId = permissions[AllPermissions.publicRead]!;
  const publicReadGroup = await Group.load(publicGroupId!);
  // if we take the next line out, the space is not visible to the public anymore
  publicReadGroup?.addMember("everyone", "reader");

  const {roomyObject: spaceObject, entityGroup, componentsGroup} = await createRoomyObject(name, permissions);

  spaceObject.name = name;
  spaceObject.description = description;
  spaceObject.version = 3;

  const spacePermissions = SpacePermissionsComponent.schema.create(permissions, publicReadGroup!);
  spaceObject.components[SpacePermissionsComponent.id] = spacePermissions.id;

  const children = ChildrenComponent.schema.create([], publicReadGroup!);
  spaceObject.components[ChildrenComponent.id] = children.id;
  
  const members = AllMembersComponent.schema.create([], publicReadGroup!);
  const me = MemberEntry.create({
    account: Account.getMe(),
    softDeleted: false,
  }, publicReadGroup!);
  members.push(me);
  spaceObject.components[AllMembersComponent.id] = members.id;

  const threads = AllThreadsComponent.schema.create([], publicReadGroup!);
  spaceObject.components[AllThreadsComponent.id] = threads.id;

  const pages = AllPagesComponent.schema.create([], publicReadGroup!);
  spaceObject.components[AllPagesComponent.id] = pages.id;

  const folders = AllFoldersComponent.schema.create([], publicReadGroup!);
  spaceObject.components[AllFoldersComponent.id] = folders.id;

  const bans = BansComponent.schema.create([], publicReadGroup!);
  spaceObject.components[BansComponent.id] = bans.id;

  if (createDefaultChannel) {
    const thread = await createThread("general", permissions);

    threads.push(thread.roomyObject);
    addToFolder(spaceObject, thread.roomyObject);
  }

  addToAllSpacesList(spaceObject.id);

  return spaceObject;
}

export async function addToAllSpacesList(spaceId: string) {
  const allSpacesList = await IDList.load(allSpacesListId);
  if (!allSpacesList) return;
  allSpacesList.push(spaceId);
}

export function isSpaceAdmin(
  space: co.loaded<typeof RoomyEntity> | undefined | null,
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
