import { Account, co, Group, z } from "jazz-tools";
import { publicGroup } from "./group.js";
import {
  Embed,
  ImageUrlEmbed,
  Message,
  Reaction,
  SubThreadsComponent,
  ThreadComponent,
  Timeline,
  VideoUrlEmbed,
} from "../schema/threads.js";
import { createRoomyEntity } from "./roomyentity.js";
import { AllPermissions } from "../schema/index.js";

export async function createThread(
  name: string,
  permissions: Record<string, string>,
) {
  const publicReadGroupId = permissions[AllPermissions.publicRead]!;
  const publicReadGroup = await Group.load(publicReadGroupId);

  const addMessagesGroupId = permissions[AllPermissions.sendMessages]!;
  const addMessagesGroup = await Group.load(addMessagesGroupId);

  const threadContentGroup = Group.create();
  threadContentGroup.addMember(publicReadGroup!, "reader");

  const timelineGroup = Group.create();
  timelineGroup.addMember(publicReadGroup!, "reader");
  timelineGroup.addMember(addMessagesGroup!, "writer");

  const addThreadsGroupId = permissions[AllPermissions.createThreads]!;
  const addThreadsGroup = await Group.load(addThreadsGroupId);

  const subThreadsGroup = Group.create();
  subThreadsGroup.addMember(publicReadGroup!, "reader");
  subThreadsGroup.addMember(addThreadsGroup!, "writer");

  const thread = ThreadComponent.schema.create(
    {
      timeline: Timeline.create([], timelineGroup),
    },
    threadContentGroup,
  );

  const { roomyObject, entityGroup, componentsGroup } = await createRoomyEntity(
    name,
    permissions,
  );

  const editEntityComponentsGroupId =
    permissions[AllPermissions.editEntityComponents]!;
  const editEntityComponentsGroup = await Group.load(
    editEntityComponentsGroupId,
  );
  componentsGroup.addMember(editEntityComponentsGroup!, "writer");

  const editEntityGroupId = permissions[AllPermissions.editEntities]!;
  const editEntityGroup = await Group.load(editEntityGroupId);
  componentsGroup.addMember(editEntityGroup!, "writer");

  const manageThreadsGroupId = permissions[AllPermissions.manageThreads]!;
  const manageThreadsGroup = await Group.load(manageThreadsGroupId);
  entityGroup.addMember(manageThreadsGroup!, "writer");

  if (!roomyObject.components) {
    throw new Error("RoomyObject components is undefined");
  }
  roomyObject.components[ThreadComponent.id] = thread.id;

  const subThreads = SubThreadsComponent.schema.create([], subThreadsGroup);
  roomyObject.components[SubThreadsComponent.id] = subThreads.id;

  return { roomyObject, thread };
}

export type ImageUrlEmbedCreate = {
  type: "imageUrl";
  data: {
    url: string;
  };
};

export type VideoUrlEmbedCreate = {
  type: "videoUrl";
  data: {
    url: string;
  };
};

export async function createMessage(
  input: string,
  replyTo?: string,
  embeds?: (ImageUrlEmbedCreate | VideoUrlEmbedCreate)[],
  permissions?: Record<string, string>,
) {
  const publicReadGroupId = permissions?.[AllPermissions.publicRead]!;
  const publicReadGroup = await Group.load(publicReadGroupId);

  const messageGroup = Group.create();
  messageGroup.addMember(publicReadGroup!, "reader");

  const addReactionsGroupId = permissions?.[AllPermissions.reactToMessages]!;
  const addReactionsGroup = await Group.load(addReactionsGroupId);

  const reactionsGroup = Group.create();
  reactionsGroup.addMember(publicReadGroup!, "reader");
  reactionsGroup.addMember(addReactionsGroup!, "writer");

  const hiddenInGroup = Group.create();
  hiddenInGroup.addMember(publicReadGroup!, "reader");

  const hideMessagesInThreadsGroupId =
    permissions?.[AllPermissions.hideMessagesInThreads]!;
  const hideMessagesInThreadsGroup = await Group.load(
    hideMessagesInThreadsGroupId,
  );
  hiddenInGroup.addMember(hideMessagesInThreadsGroup!, "writer");

  let embedsList;
  if (embeds && embeds.length > 0) {
    const embedsGroup = Group.create();
    embedsGroup.addMember(publicReadGroup!, "reader");

    embedsList = co.list(Embed).create([], embedsGroup);
    for (const embed of embeds) {
      const embedGroup = Group.create();
      embedGroup.addMember(publicReadGroup!, "reader");

      if (embed.type === "imageUrl") {
        const imageUrlEmbed = ImageUrlEmbed.create(
          { url: embed.data.url },
          embedGroup,
        );

        embedsList.push(
          Embed.create(
            { type: "imageUrl", embedId: imageUrlEmbed.id },
            embedGroup,
          ),
        );
      } else if (embed.type === "videoUrl") {
        const videoUrlEmbed = VideoUrlEmbed.create(
          { url: embed.data.url },
          embedGroup,
        );
        embedsList.push(
          Embed.create(
            { type: "videoUrl", embedId: videoUrlEmbed.id },
            embedGroup,
          ),
        );
      }
    }
  }

  const message = Message.create(
    {
      content: input,
      createdAt: new Date(),
      updatedAt: new Date(),
      reactions: co.list(Reaction).create([], reactionsGroup),
      replyTo: replyTo,
      hiddenIn: co.list(z.string()).create([], hiddenInGroup),
      embeds: embedsList,
    },
    messageGroup,
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
