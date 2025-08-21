import { Account, co, Group, z } from "jazz-tools";
import { allSpacesListId, discoverableSpacesFeedId } from "../ids.js";
import {
  addComponent,
  AllFoldersComponent,
  AllMembersComponent,
  AllPagesComponent,
  AllThreadsComponent,
  BansComponent,
  getComponent,
  IDFeed,
  IDList,
  RoomyAccount,
  RoomyEntity,
  SpaceGroupKeys,
  SpaceGroupsComponent,
} from "../schema/index.js";
import { createThread } from "./thread.js";
import { addToFolder } from "./folder.js";
import { createRoomyEntity } from "./roomyentity.js";
import { ChildrenComponent } from "../schema/folder.js";
import { addMemberToSpace } from "./members.js";
import { isSpaceAdmin } from "./permissions.js";

export async function getSpaceGroups(
  space: co.loaded<typeof RoomyEntity>,
): Promise<{ [key in SpaceGroupKeys]: Group }> {
  const groups = await getComponent(space, SpaceGroupsComponent);
  if (!groups) throw new Error("Could not get space groups");
  const admin = await Group.load(groups.admin);
  if (!admin) throw new Error("Error loading admin group");
  const publicG = await Group.load(groups.public);
  if (!publicG) throw new Error("Error loading admin group");
  return { admin, public: publicG };
}

/**
 * Get the group that normal users user should use as the owner for all their entities in the
 * provided space.
 *
 * This group will allow edits by the current account and by space admins.
 */
export async function getUserSpaceGroup(
  space: co.loaded<typeof RoomyEntity>,
): Promise<Group> {
  // Load the user profile
  const account = RoomyAccount.getMe();
  await account.ensureLoaded({ resolve: { profile: true } });
  if (!account.profile)
    throw new Error("Account profile is null, can't get user space group. 1");
  const profile = account.profile;

  // Create the space groups on our profile if it doesn't exist
  if (!profile.spaceGroups) {
    profile.spaceGroups = co.record(z.string(), z.string()).create({});
  }

  // Get the existing space group ID if it exists.
  const spaceGroupId = profile.spaceGroups[space.id];

  // Return the already existing space group for this user if it exists
  if (spaceGroupId) {
    const spaceGroup = await Group.load(spaceGroupId);
    if (!spaceGroup) throw new Error("Could not load space group.");
    return spaceGroup;
  }

  // If the space group doesn't exist yet, create it.

  // First make sure the space is loaded so we can get admin group of the space
  const groups = await getComponent(space, SpaceGroupsComponent);
  if (!groups) throw new Error("Space groups does not exist");
  const adminGroup = await Group.load(groups.admin);
  if (!adminGroup) throw new Error("Could not load admin group for space");

  // Finally create our new space group
  const spaceGroup = Group.create();

  // Add the admin group as a writer for this group so that admins will be able
  // to edit all of our messages in this space.
  spaceGroup.addMember(adminGroup, "writer");

  // Record the new group as our space group for this space
  profile.spaceGroups[space.id] = spaceGroup.id;

  // And return it.
  return spaceGroup;
}

export async function createSpace(
  name: string,
  description?: string,
  createDefaultChannel: boolean = true,
): Promise<{
  entity: co.loaded<typeof RoomyEntity>;
  groups: co.loaded<typeof SpaceGroupsComponent>;
  folders: co.loaded<typeof AllFoldersComponent>;
  threads: co.loaded<typeof AllThreadsComponent>;
  bans: co.loaded<typeof BansComponent>;
  pages: co.loaded<typeof AllPagesComponent>;
  children: co.loaded<typeof ChildrenComponent>;
  members: co.loaded<typeof AllMembersComponent>;
}> {
  // We have a public group that every normal user in the space is a member of.
  const publicGroup = Group.create();
  // We have an admin group that only admins are a member of.
  const adminGroup = Group.create();

  // Chat spaces are completely public so both groups have everyone as a reader.
  publicGroup.addMember("everyone", "reader");
  adminGroup.addMember("everyone", "reader");
  // Admins are automatically writers to the public group, i.e. so we don't have to add admins
  // manually to both groups to give them normal user permissions as well as admin permissions.
  publicGroup.addMember(adminGroup, "writer");

  // PERMISSIONS SCENARIOS
  //
  // All scenarios include everybody being able to read ( spaces are public )
  //
  // - Writable by everybody in the space: make it owned by publicGroup
  // - Writable only by admins: make it owned by adminGroup
  // - Writeable by the current user, and admins: each user has a mapping of space ID to group
  //   that for every space holds a group that they are an admin of and that they grant adminGroup
  //   for the space write access to. Use this group for this scenario.

  // create space entity
  const entity = await createRoomyEntity(name, adminGroup);

  entity.name = name;
  entity.description = description;
  entity.version = 3;

  const groups = await addComponent(
    entity,
    SpaceGroupsComponent,
    {
      public: publicGroup.id,
      admin: adminGroup.id,
    },
    { owner: adminGroup },
  );
  const children = await addComponent(
    entity,
    ChildrenComponent,
    [],
    adminGroup,
  );
  const members = await addComponent(
    entity,
    AllMembersComponent,
    [],
    publicGroup,
  );
  await addMemberToSpace(Account.getMe(), entity);
  const threads = await addComponent(
    entity,
    AllThreadsComponent,
    [],
    publicGroup,
  );
  const pages = await addComponent(entity, AllPagesComponent, [], publicGroup);
  const folders = await addComponent(
    entity,
    AllFoldersComponent,
    [],
    adminGroup,
  );
  const bans = await addComponent(entity, BansComponent, [], adminGroup);

  // add invite account to the public group as admin get from the invite service
  try {
    const inviteAccountId = await fetch(
      `http://localhost:8000/service-id`,
    ).then((res) => res.text());
    if (inviteAccountId) {
      console.log("adding invite account to member role", inviteAccountId);
      const inviteAccount = await co.account().load(inviteAccountId);
      if (inviteAccount) {
        publicGroup.addMember(inviteAccount, "admin");
      }
    }
  } catch (error) {
    console.error("error adding invite account to member role", error);
  }

  if (createDefaultChannel) {
    const { entity: thread } = await createThread("general", {
      public: publicGroup,
      admin: adminGroup,
    });

    threads.push(thread);
    await addToFolder(entity, thread);
  }

  addToAllSpacesList(entity.id);

  return { entity, groups, threads, children, folders, pages, bans, members };
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

export async function isCurrentAccountSpaceAdmin(
  space: co.loaded<typeof RoomyEntity> | undefined | null,
) {
  if (!space) return false;
  try {
    const me = Account.getMe();
    return isSpaceAdmin(me, space);
  } catch (error) {
    return false;
  }
}
