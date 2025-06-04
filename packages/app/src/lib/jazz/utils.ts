import { Account, co, CoRichText, Group, z, type Loaded } from "jazz-tools";
import {
  Channel,
  Message,
  Reaction,
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
) {
  const channel = createChannel("general");

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
    },
    readerGroup,
  );

  return space;
}

export function joinSpace(space: Loaded<typeof Space>) {
  space.members?.push(Account.getMe());
}

export function isSpaceAdmin(space: Loaded<typeof Space>) {
  try {
    const me = Account.getMe();
    return me.canAdmin(space);
  } catch (error) {
    return false;
  }
}

export function messageHasAdmin(
  message: Loaded<typeof Message>,
  admin: Account,
) {
  console.log("messageHasAdmin", message, admin);
  return admin.canAdmin(message);
}

export function createPublicSpacesList() {
  const spaces = SpaceList.create([], {
    owner: publicGroup(),
  });

  return spaces;
}

export function createMessage(
  input: string,
  images: string[],
  admin: Account,
  replyTo?: string,
) {
  const adminGroup = Group.create();
  adminGroup.addMember(admin, "admin");
  const readingGroup = publicGroup("reader");
  readingGroup.extend(adminGroup);

  const content = new CoRichText({
    text: input,
    owner: readingGroup,
  });

  const message = Message.create(
    {
      content,
      createdAt: new Date(),
      updatedAt: new Date(),
      images: co.list(z.string()).create([...images], readingGroup),
      reactions: co.list(Reaction).create([], publicGroup()),
      replyTo: replyTo,
      type: "message",
    },
    readingGroup,
  );

  return message;
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
