import { Account, co, Group } from "jazz-tools";
import {
  AllMembersComponent,
  getComponent,
  MemberEntry,
  RoomyEntity,
} from "../schema";
import { getUserSpaceGroup } from "./space";

export async function addMemberToSpace(
  member: Account,
  space: co.loaded<typeof RoomyEntity>,
) {
  // Get the members component
  const members = await getComponent(space, AllMembersComponent);
  if (!members) throw new Error("Members or Groups component not found");

  // Get our space group
  const spaceGroup = await getUserSpaceGroup(space);

  // Add a new member entry for us.
  members.push(
    MemberEntry.create(
      {
        account: member,
        softDeleted: false,
      },
      spaceGroup,
    ),
  );
}
