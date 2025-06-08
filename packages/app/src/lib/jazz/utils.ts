import { Account, co, CoRichText, Group, z } from "jazz-tools";
import {
  Category,
  Channel,
  Embed,
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

export function publicGroup(readWrite: "reader" | "writer" = "writer") {
  const group = Group.create();
  group.addMember("everyone", readWrite);

  return group;
}

export function createChannel(name: string) {
  const group = publicGroup();

  const thread = Thread.create(
    {
      name: "main",
      timeline: Timeline.create([], {
        owner: group,
      }),
    },
    {
      owner: group,
    },
  );

  const channel = Channel.create(
    {
      name,
      mainThread: thread,
      subThreads: co.list(Thread).create([], {
        owner: group,
      }),
    },
    {
      owner: group,
    },
  );

  return channel;
}

export function createSpace(
  name: string,
  description?: string,
  emoji?: string,
  defaultChannelName?: string,
) {
  const channel = createChannel(defaultChannelName || "general");

  // user is already admin
  const adminGroup = Group.create();

  const readerGroup = Group.create();
  // add reading for everyone
  readerGroup.addMember("everyone", "reader");
  readerGroup.extend(adminGroup);

  const me = Account.getMe();

  const space = Space.create(
    {
      name,
      channels: co.list(Channel).create([channel], readerGroup),
      description,
      emoji,
      members: co.list(co.account()).create([Account.getMe()], publicGroup()),
      version: 1,
      adminId: me.id,
      threads: co.list(Thread).create([], publicGroup()),
      pages: co.list(Page).create([], publicGroup()),
      categories: co.list(Category).create([], readerGroup),
      bans: co.list(z.string()).create([], readerGroup),
    },
    readerGroup,
  );

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

export function createPublicSpacesList() {
  const spaces = SpaceList.create([], {
    owner: publicGroup(),
  });

  return spaces;
}

export type ImageUrlEmbedCreate = {
  type: "imageUrl";
  data: {
    url: string;
  };
};

export function createMessage(
  input: string,
  replyTo?: string,
  admin?: Account,
  embeds?: ImageUrlEmbedCreate[],
) {
  const readingGroup = publicGroup("reader");

  if (admin) {
    const adminGroup = Group.create();
    adminGroup.addMember(admin, "admin");
    readingGroup.extend(adminGroup);
  }

  const content = new CoRichText({
    text: input,
    owner: readingGroup,
  });

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

  const message = Message.create(
    {
      content,
      createdAt: new Date(),
      updatedAt: new Date(),
      reactions: co.list(Reaction).create([], publicGroup()),
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

export function createThread(messagesIds: string[], name?: string) {
  const thread = Thread.create(
    {
      name: name || "New Thread",
      timeline: Timeline.create([...messagesIds], publicGroup()),
    },
    publicGroup(),
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