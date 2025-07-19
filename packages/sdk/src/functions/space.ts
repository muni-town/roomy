import { Account, co, Group } from "jazz-tools";
import { allSpacesListId } from "../ids.js";
import {
  AllFoldersComponent,
  AllMembersComponent,
  AllPagesComponent,
  AllPermissions,
  AllThreadsComponent,
  BansComponent,
  IDList,
  MemberEntry,
  RoomyEntity,
  Space,
  SpacePermissionsComponent,
  SpaceRolesComponent,
} from "../schema/index.js";
import { createThread } from "./thread.js";
import { addToFolder } from "./folder.js";
import { createRoomyEntity } from "./roomyentity.js";
import { addRoleToPermissions, createPermissions } from "./permissions.js";
import { ChildrenComponent } from "../schema/folder.js";

export async function createSpace(
  name: string,
  description?: string,
  createDefaultChannel: boolean = true,
) {
  const permissions = createPermissions();

  const publicGroupId = permissions[AllPermissions.publicRead]!;
  const publicReadGroup = await Group.load(publicGroupId);
  // if we take the next line out, the space is not visible to the public anymore
  publicReadGroup?.addMember("everyone", "reader");

  // create space entity
  const {
    roomyObject: spaceObject,
    entityGroup,
    componentsGroup,
  } = await createRoomyEntity(name, permissions);
  const editSpaceGroupId = permissions[AllPermissions.editSpace]!;
  const editSpaceGroup = await Group.load(editSpaceGroupId);
  entityGroup.addMember(editSpaceGroup!, "writer");
  componentsGroup.addMember(editSpaceGroup!, "writer");

  spaceObject.name = name;
  spaceObject.description = description;
  spaceObject.version = 3;

  // add all the components a space needs

  // create permissions component
  const permissionsGroup = Group.create();
  const editPermissionsGroupId =
    permissions[AllPermissions.editSpacePermissions]!;
  const editPermissionsGroup = await Group.load(editPermissionsGroupId);
  permissionsGroup.addMember(publicReadGroup!, "reader");
  permissionsGroup.addMember(editPermissionsGroup!, "writer");
  const spacePermissions = SpacePermissionsComponent.schema.create(
    permissions,
    permissionsGroup,
  );
  spaceObject.components[SpacePermissionsComponent.id] = spacePermissions.id;

  // create children component
  const childrenGroup = Group.create();
  const addRootChildrenGroupId = permissions[AllPermissions.addRootChildren]!;
  const addRootChildrenGroup = await Group.load(addRootChildrenGroupId);
  childrenGroup.addMember(addRootChildrenGroup!, "writer");
  childrenGroup.addMember(publicReadGroup!, "reader");
  const children = ChildrenComponent.schema.create([], childrenGroup);
  spaceObject.components[ChildrenComponent.id] = children.id;

  // create members component
  const membersGroup = Group.create();
  const addMembersGroupId = permissions[AllPermissions.addMembers]!;
  const addMembersGroup = await Group.load(addMembersGroupId);
  const seeMembersGroupId = permissions[AllPermissions.seeMembers]!;
  const seeMembersGroup = await Group.load(seeMembersGroupId);
  membersGroup.addMember(addMembersGroup!, "writer");
  membersGroup.addMember(seeMembersGroup!, "reader");

  const memberGroup = Group.create();
  const editMembersGroupId = permissions[AllPermissions.manageMembers]!;
  const editMembersGroup = await Group.load(editMembersGroupId);
  memberGroup.addMember(editMembersGroup!, "writer");
  memberGroup.addMember(seeMembersGroup!, "reader");

  const members = AllMembersComponent.schema.create([], membersGroup);
  const me = MemberEntry.create(
    {
      account: Account.getMe(),
      softDeleted: false,
    },
    memberGroup,
  );
  members.push(me);
  spaceObject.components[AllMembersComponent.id] = members.id;

  // create all threads component
  const threadsGroup = Group.create();
  const createThreadsGroupId = permissions[AllPermissions.createThreads]!;
  const createThreadsGroup = await Group.load(createThreadsGroupId);
  threadsGroup.addMember(createThreadsGroup!, "writer");
  threadsGroup.addMember(publicReadGroup!, "reader");
  const threads = AllThreadsComponent.schema.create([], threadsGroup);
  spaceObject.components[AllThreadsComponent.id] = threads.id;

  const manageChildrenGroupId = permissions[AllPermissions.manageChildren]!;
  const manageChildrenGroup = await Group.load(manageChildrenGroupId);

  // create all pages component
  const pagesGroup = Group.create();
  pagesGroup.addMember(manageChildrenGroup!, "writer");
  pagesGroup.addMember(publicReadGroup!, "reader");
  const pages = AllPagesComponent.schema.create([], pagesGroup);
  spaceObject.components[AllPagesComponent.id] = pages.id;

  // create all folders component
  const foldersGroup = Group.create();
  foldersGroup.addMember(manageChildrenGroup!, "writer");
  foldersGroup.addMember(publicReadGroup!, "reader");
  const folders = AllFoldersComponent.schema.create([], foldersGroup);
  spaceObject.components[AllFoldersComponent.id] = folders.id;

  // create bans component
  const bansGroup = Group.create();
  const banMembersGroupId = permissions[AllPermissions.banMembers]!;
  const banMembersGroup = await Group.load(banMembersGroupId);
  bansGroup.addMember(banMembersGroup!, "writer");
  bansGroup.addMember(publicReadGroup!, "reader");
  const bans = BansComponent.schema.create([], bansGroup);
  spaceObject.components[BansComponent.id] = bans.id;

  // create member roles component
  const memberRole = Group.create();
  const manageRolesGroupId = permissions[AllPermissions.manageRoles]!;
  const manageRolesGroup = await Group.load(manageRolesGroupId);
  memberRole.addMember(manageRolesGroup!, "writer");
  memberRole.addMember(publicReadGroup!, "reader");
  const roles = SpaceRolesComponent.schema.create(
    { member: memberRole.id },
    memberRole,
  );
  spaceObject.components[SpaceRolesComponent.id] = roles.id;

  await addRoleToPermissions(
    memberRole,
    [
      AllPermissions.publicRead,
      AllPermissions.viewMessages,
      AllPermissions.sendMessages,
      AllPermissions.reactToMessages,
      AllPermissions.createThreads,
      AllPermissions.seeMembers,
      AllPermissions.addMembers,
    ],
    permissions,
  );

  // for testing
  // add account co_zfQX8vuu3sW4dSLirrEg7qHV5bF to member role
  const account = await co.account().load("co_zfQX8vuu3sW4dSLirrEg7qHV5bF");
  if (account) {
    console.log("adding account to member role", account.id);
    memberRole.addMember(account, "writer");
  }

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
