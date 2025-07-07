import { Account, co, Group, z } from "jazz-tools";
import { publicGroup } from "./group.ts";
import { Embed, ImageUrlEmbed, Message, Reaction, ThreadContent, Timeline } from "../schema/threads.ts";
import { createRoomyObject } from "./roomyobject.ts";

export function createThread(name: string, adminGroup: Group) {
  const publicWriteGroup = publicGroup("writer");
  const publicReadGroup = publicGroup("reader");

  const thread = ThreadContent.create(
    {
      timeline: Timeline.create([], publicWriteGroup),
    },
    publicReadGroup,
  );

  const roomyObject = createRoomyObject(name, adminGroup, true);

  if (!roomyObject.content) {
    throw new Error("RoomyObject content is undefined");
  }
  roomyObject.content.thread = thread.id;

  return { roomyObject, thread };
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


export function messageHasAdmin(
  message: co.loaded<typeof Message>,
  admin: co.loaded<typeof Account>,
) {
  if (!admin) return false;
  return admin.canAdmin(message);
}
