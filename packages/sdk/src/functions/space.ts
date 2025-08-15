import { Account, co, Group } from "jazz-tools";
import { allSpacesListId, discoverableSpacesFeedId } from "../ids.js";
import {
  AllFoldersComponent,
  AllMembersComponent,
  AllPagesComponent,
  AllPermissions,
  AllThreadsComponent,
  BansComponent,
  IDFeed,
  IDList,
  RoomyEntity,
  SpacePermissionsComponent,
  SpaceRolesComponent,
} from "../schema/index.js";
import { createThread } from "./thread.js";
import { addToFolder } from "./folder.js";
import { createRoomyEntity } from "./roomyentity.js";
import { addRoleToPermissions, createPermissions } from "./permissions.js";
import { ChildrenComponent } from "../schema/folder.js";
import { addMemberToSpace } from "./members.js";

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
    // entityGroup,
    // componentsGroup,
  } = await createRoomyEntity(name, permissions);
  // const editSpaceGroupId = permissions[AllPermissions.editSpace]!;
  // const editSpaceGroup = await Group.load(editSpaceGroupId);
  // entityGroup.addMember(editSpaceGroup!, "writer");
  // componentsGroup.addMember(editSpaceGroup!, "writer");

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
  const spacePermissions = SpacePermissionsComponent.create(
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
  const children = ChildrenComponent.create([], childrenGroup);
  spaceObject.components[ChildrenComponent.id] = children.id;

  // create members component
  const membersGroup = Group.create();
  const addMembersGroupId = permissions[AllPermissions.addMembers]!;
  const addMembersGroup = await Group.load(addMembersGroupId);
  const seeMembersGroupId = permissions[AllPermissions.seeMembers]!;
  const seeMembersGroup = await Group.load(seeMembersGroupId);
  membersGroup.addMember(addMembersGroup!, "writer");
  membersGroup.addMember(seeMembersGroup!, "reader");

  const members = AllMembersComponent.create([], membersGroup);
  spaceObject.components[AllMembersComponent.id] = members.id;
  await addMemberToSpace(Account.getMe(), spaceObject);

  // create all threads component
  const threadsGroup = Group.create();
  const createThreadsGroupId = permissions[AllPermissions.createThreads]!;
  const createThreadsGroup = await Group.load(createThreadsGroupId);
  threadsGroup.addMember(createThreadsGroup!, "writer");
  threadsGroup.addMember(publicReadGroup!, "reader");
  const threads = AllThreadsComponent.create([], threadsGroup);
  spaceObject.components[AllThreadsComponent.id] = threads.id;

  const manageChildrenGroupId = permissions[AllPermissions.manageChildren]!;
  const manageChildrenGroup = await Group.load(manageChildrenGroupId);

  // create all pages component
  const pagesGroup = Group.create();
  pagesGroup.addMember(manageChildrenGroup!, "writer");
  pagesGroup.addMember(publicReadGroup!, "reader");
  const pages = AllPagesComponent.create([], pagesGroup);
  spaceObject.components[AllPagesComponent.id] = pages.id;

  // create all folders component
  const foldersGroup = Group.create();
  foldersGroup.addMember(manageChildrenGroup!, "writer");
  foldersGroup.addMember(publicReadGroup!, "reader");
  const folders = AllFoldersComponent.create([], foldersGroup);
  spaceObject.components[AllFoldersComponent.id] = folders.id;

  // create bans component
  const bansGroup = Group.create();
  const banMembersGroupId = permissions[AllPermissions.banMembers]!;
  const banMembersGroup = await Group.load(banMembersGroupId);
  bansGroup.addMember(banMembersGroup!, "writer");
  bansGroup.addMember(publicReadGroup!, "reader");
  const bans = BansComponent.create([], bansGroup);
  spaceObject.components[BansComponent.id] = bans.id;

  // create member roles component
  const memberRole = Group.create();

  const rolesGroup = Group.create();
  const manageRolesGroupId = permissions[AllPermissions.manageRoles]!;
  const manageRolesGroup = await Group.load(manageRolesGroupId);
  rolesGroup.addMember(manageRolesGroup!, "writer");
  rolesGroup.addMember(publicReadGroup!, "reader");
  const roles = SpaceRolesComponent.create(
    { member: memberRole.id },
    rolesGroup,
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

  // add invite account to member role as admin
  // get from https://invites.roomy.space/service-id
  try {
    const inviteAccountId = await fetch(
      "https://invites.roomy.space/service-id",
    ).then((res) => res.text());
    if (inviteAccountId) {
      console.log("adding invite account to member role", inviteAccountId);
      const inviteAccount = await co.account().load(inviteAccountId);
      if (inviteAccount) {
        memberRole.addMember(inviteAccount, "admin");
      }
    }
  } catch (error) {
    console.error("error adding invite account to member role", error);
  }

  // for testing for now we'll use an invite link instead
  // const inviteLink = createInviteLink(memberRole, "reader");
  // const inviteLinkParts = inviteLink.split("#/invite/");
  // const inviteLinkId = inviteLinkParts[1];

  // if (inviteLinkId) {
  //   spaceObject.components.invite = inviteLinkId;
  // }

  console.log("members id", memberRole.id);

  spaceObject.components.memberRole = memberRole.id;

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

export async function addToDiscoverableSpacesFeed(spaceId: string) {
  const discoverableSpacesFeed = await IDFeed.load(discoverableSpacesFeedId);
  if (!discoverableSpacesFeed) return;
  discoverableSpacesFeed.push(spaceId);
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
