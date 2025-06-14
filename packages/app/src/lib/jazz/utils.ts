import { Account, co, Group, z } from "jazz-tools";
import {
  Category,
  Channel,
  Embed,
  IDList,
  ImageUrlEmbed,
  InboxItem,
  Message,
  Page,
  Reaction,
  RoomyAccount,
  Space,
  SpaceList,
  Thread,
  Timeline,
} from "./schema";
import { allAccountsListId, allSpacesListId } from "./ids";

export function publicGroup(readWrite: "reader" | "writer" = "reader") {
  const group = Group.create();
  group.addMember("everyone", readWrite);

  return group;
}

export function createChannel(name: string) {
  const publicWriteGroup = publicGroup("writer");
  const publicReadGroup = publicGroup("reader");

  const thread = Thread.create(
    {
      name: "main",
      timeline: Timeline.create([], publicWriteGroup),
      channelId: "",
    },
    publicReadGroup,
  );

  const channel = Channel.create(
    {
      name,
      mainThread: thread,
      subThreads: co.list(Thread).create([], publicWriteGroup),
    },
    publicReadGroup,
  );

  thread.channelId = channel.id;

  return channel;
}

export function enableAtprotoFeeds(channel: co.loaded<typeof Channel>, feedUris: string[], threadsOnly = false) {
  channel.showAtprotoFeeds = true;
  channel.atprotoFeedsConfig = {
    feeds: feedUris,
    threadsOnly: threadsOnly,
  };
  return channel;
}

export function createSpace(
  name: string,
  description?: string,
  createDefaultChannel: boolean = true,
) {
  const channel = createDefaultChannel ? createChannel("general") : undefined;

  // user is already admin
  const adminGroup = Group.create();

  const readerGroup = Group.create();
  // add reading for everyone
  readerGroup.addMember("everyone", "reader");
  readerGroup.extend(adminGroup);

  const publicWriteGroup = publicGroup("writer");

  const space = Space.create(
    {
      name,
      channels: co.list(Channel).create(channel ? [channel] : [], readerGroup),
      description,
      members: co
        .list(co.account())
        .create([Account.getMe()], publicWriteGroup),
      version: 1,
      creatorId: Account.getMe().id,
      adminGroupId: adminGroup.id,
      threads: co.list(Thread).create([], publicWriteGroup),
      pages: co.list(Page).create([], publicWriteGroup),
      categories: co.list(Category).create([], readerGroup),
      bans: co.list(z.string()).create([], readerGroup),
    },
    readerGroup,
  );

  addToAllSpacesList(space.id);

  return space;
}

export function createCategory(name: string) {
  const category = Category.create(
    {
      name,
      channels: co.list(Channel).create([], publicGroup("reader")),
    },
    publicGroup("reader"),
  );
  return category;
}

export function joinSpace(space: co.loaded<typeof Space>) {
  space.members?.push(Account.getMe());
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

export function messageHasAdmin(
  message: co.loaded<typeof Message>,
  admin: co.loaded<typeof Account>,
) {
  if (!admin) return false;
  return admin.canAdmin(message);
}

export type ImageUrlEmbedCreate = {
  type: "imageUrl";
  data: {
    url: string;
  };
};

export async function makeSpaceAdmin(spaceId: string, accountId: string) {
  const space = await Space.load(spaceId);
  if (!space) return;
  const adminGroup = await Group.load(space.adminGroupId);
  if (!adminGroup) return;
  const account = await Account.load(accountId);
  console.log("account", account);
  if (!account) return;
  adminGroup.addMember(account, "admin");
  space.adminGroupId = adminGroup.id;

  return space;
}

export function createMessage(
  input: string,
  replyTo?: string,
  admin?: co.loaded<typeof Group>,
  embeds?: ImageUrlEmbedCreate[],
) {
  const readingGroup = publicGroup("reader");

  if (admin) {
    readingGroup.extend(admin);
  }

  let embedsList;
  if (embeds && embeds.length > 0) {
    embedsList = co.list(Embed).create([], readingGroup);
    for (const embed of embeds) {
      const imageUrlEmbed = ImageUrlEmbed.create(
        { url: embed.data.url },
        readingGroup,
      );

      embedsList.push(
        Embed.create(
          { type: "imageUrl", embedId: imageUrlEmbed.id },
          readingGroup,
        ),
      );
    }
  }
  const publicWriteGroup = publicGroup("writer");

  const message = Message.create(
    {
      content: input,
      createdAt: new Date(),
      updatedAt: new Date(),
      reactions: co.list(Reaction).create([], publicWriteGroup),
      replyTo: replyTo,
      hiddenIn: co.list(z.string()).create([], readingGroup),
      embeds: embedsList,
    },
    readingGroup,
  );

  return message;
}

export function createPage(name: string) {
  const readingGroup = publicGroup();

  const page = Page.create(
    {
      name,
      body: "",
    },
    readingGroup,
  );

  return page;
}

export function createThread(
  messagesIds: string[],
  channelId: string,
  name?: string,
) {
  const publicWriteGroup = publicGroup("writer");
  const publicReadGroup = publicGroup("reader");

  const thread = Thread.create(
    {
      name: name || "New Thread",
      timeline: Timeline.create([...messagesIds], publicWriteGroup),
      channelId,
    },
    publicReadGroup,
  );

  return thread;
}

export function createSpaceList() {
  const spaces = SpaceList.create([], publicGroup("reader"));

  return spaces;
}

export function createPagesList() {
  const pages = co.list(Page).create([], publicGroup());

  return pages;
}

export function spacePages(space: co.loaded<typeof Space>) {
  const pages: co.loaded<typeof Page>[] = [];
  const channels = space.channels;
  if (!channels) return pages;
  for (const channel of channels) {
    if (!channel || !channel.pages) continue;
    for (const page of channel.pages) {
      if (page) pages.push(page);
    }
  }
  return pages;
}

export async function addToInbox(
  accountId: string,
  type: "reply" | "mention",
  messageId: string,
  spaceId: string,
  channelId?: string,
  threadId?: string,
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
        channelId,
        threadId,
        read: false,
      },
      group,
    ),
  );
}

export function createInbox() {
  const group = Group.create();
  group.addMember("everyone", "writeOnly");

  const inbox = co.list(InboxItem).create([], group);

  return inbox;
}

export async function addToAllSpacesList(spaceId: string) {
  const allSpacesList = await IDList.load(allSpacesListId);
  if (!allSpacesList) return;
  allSpacesList.push(spaceId);
}

export async function addToAllAccountsList(accountId: string) {
  const allAccountsList = await IDList.load(allAccountsListId);
  if (!allAccountsList) return;
  allAccountsList.push(accountId);
}