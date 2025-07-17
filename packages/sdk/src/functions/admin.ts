import { Account, Group } from "jazz-tools";
import { Space } from "../schema/bundles";

export async function makeSpaceAdmin(spaceId: string, accountId: string) {
  // const space = await Space.load(spaceId);
  // if (!space) return;
  // const adminGroup = await Group.load(space.adminGroupId);
  // if (!adminGroup) return;
  // const account = await Account.load(accountId);
  // console.log("account", account);
  // if (!account) return;
  // adminGroup.addMember(account, "admin");
  // space.adminGroupId = adminGroup.id;

  // return space;
}
