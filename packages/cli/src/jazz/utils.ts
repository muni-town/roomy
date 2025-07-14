import { Account, co, Group, z } from "jazz-tools";
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
} from "./schema.js";

export function publicGroup(readWrite: "reader" | "writer" = "reader") {
  const group = Group.create();
  group.addMember("everyone", readWrite);

  return group;
}

export function createMessage(
  input: string,
  replyTo?: string,
  admin?: co.loaded<typeof Group>,
  embeds?: Array<{ type: "imageUrl"; data: { url: string } }>,
) {
  const readingGroup = publicGroup("reader");

  if (admin) {
    readingGroup.extend(admin);
  }

  let embedsList;
  if (embeds && embeds.length > 0) {
    embedsList = co.list(Embed).create([], readingGroup);
    for (const embed of embeds) {
      if (embed.type === "imageUrl" && embed.data.url) {
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

export function createSpaceList() {
  const spaces = SpaceList.create([], publicGroup("reader"));
  return spaces;
}

export function createInbox() {
  const group = Group.create();
  group.addMember("everyone", "writeOnly");
  const inbox = co.list(InboxItem).create([], group);
  return inbox;
}