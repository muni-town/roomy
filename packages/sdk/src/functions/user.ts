import { co, Group } from "jazz-tools";
import { IDList, InboxItem, RoomyAccount } from "../schema/index.js";
import { allAccountsListId } from "../ids.js";

export function createInbox() {
  const group = Group.create();
  group.addMember("everyone", "writeOnly");

  const inbox = co.list(InboxItem).create([], group);

  return inbox;
}

export async function addToAllAccountsList(accountId: string) {
  const allAccountsList = await IDList.load(allAccountsListId);
  if (!allAccountsList) return;
  allAccountsList.push(accountId);
}

export async function addToInbox(
  accountId: string,
  type: "reply" | "mention",
  messageId: string,
  spaceId: string,
  objectId?: string,
) {
  const account = await RoomyAccount.load(accountId, {
    resolve: {
      profile: {
        roomyInbox: true,
      },
    },
  });
  if (!account?.profile.roomyInbox) {
    console.error("Account has no inbox");
    return;
  }

  const group = Group.create();
  group.addMember(account, "admin");

  const inbox = account.profile.roomyInbox;
  inbox.push(
    InboxItem.create(
      {
        type,
        messageId,
        spaceId,
        objectId,
        read: false,
      },
      group,
    ),
  );
}
