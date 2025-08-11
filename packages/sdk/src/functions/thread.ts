import { Account, co, Group, z } from "jazz-tools";
import {
  Embed,
  EmbedsComponent,
  HiddenInComponent,
  ImageUrlEmbed,
  PlainTextContentComponent,
  Reaction,
  ReactionList,
  ReactionsComponent,
  ReplyToComponent,
  SubThreadsComponent,
  ThreadComponent,
  Timeline,
  UserAccessTimesComponent,
  VideoUrlEmbed,
} from "../schema/threads.js";
import { createRoomyEntity } from "./roomyentity.js";
import { AllPermissions, RoomyEntity } from "../schema/index.js";

export async function createThread(
  name: string,
  permissions: Record<string, string>,
) {
  const publicReadGroupId = permissions[AllPermissions.publicRead]!;
  const publicReadGroup = await Group.load(publicReadGroupId);
  if (!publicReadGroup) throw new Error("Could not load publicReadGroup");

  const addMessagesGroupId = permissions[AllPermissions.sendMessages]!;
  const addMessagesGroup = await Group.load(addMessagesGroupId);
  if (!addMessagesGroup) throw new Error("Could not load addMessagesGroup");

  const threadContentGroup = Group.create();
  threadContentGroup.addMember(publicReadGroup, "reader");

  const timelineGroup = Group.create();
  timelineGroup.addMember(publicReadGroup, "reader");
  timelineGroup.addMember(addMessagesGroup, "writer");

  const addThreadsGroupId = permissions[AllPermissions.createThreads]!;
  const addThreadsGroup = await Group.load(addThreadsGroupId);
  if (!addThreadsGroup) throw new Error("Could not load addThreadsGroup");

  const subThreadsGroup = Group.create();
  subThreadsGroup.addMember(publicReadGroup, "reader");
  subThreadsGroup.addMember(addThreadsGroup, "writer");

  const thread = ThreadComponent.create(
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

  const subThreads = SubThreadsComponent.create([], subThreadsGroup);
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

interface CreateMessageOptions {
  replyTo?: string;
  permissions?: Record<string, string>;
  embeds?: (ImageUrlEmbedCreate | VideoUrlEmbedCreate)[];
  created?: Date;
  updated?: Date;
}

export async function createMessage(
  input: string,
  opts?: CreateMessageOptions,
) {
  const permissions = opts?.permissions || {};
  const publicReadGroupId = permissions?.[AllPermissions.publicRead];
  const publicReadGroup = await Group.load(publicReadGroupId || "");

  const messageGroup = Group.create();
  messageGroup.addMember(publicReadGroup!, "reader");

  const addReactionsGroupId = permissions?.[AllPermissions.reactToMessages];
  const addReactionsGroup = await Group.load(addReactionsGroupId || "");

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

  const { roomyObject, entityGroup, componentsGroup } = await createRoomyEntity(
    "",
    permissions,
  );

  if (!roomyObject.components) {
    throw new Error("RoomyObject components is undefined");
  }

  const editEntityComponentsGroupId =
    permissions[AllPermissions.editEntityComponents]!;
  const editEntityComponentsGroup = await Group.load(
    editEntityComponentsGroupId,
  );
  componentsGroup.addMember(editEntityComponentsGroup!, "writer");

  const editEntityGroupId = permissions[AllPermissions.editEntities]!;
  const editEntityGroup = await Group.load(editEntityGroupId);
  componentsGroup.addMember(editEntityGroup!, "writer");

  const editMessagesGroupId = permissions[AllPermissions.editMessages]!;
  const editMessagesGroup = await Group.load(editMessagesGroupId);
  entityGroup.addMember(editMessagesGroup!, "writer");

  const content = PlainTextContentComponent.create(
    { content: input },
    componentsGroup,
  );
  roomyObject.components[PlainTextContentComponent.id] = content.id;

  const userAccessTimes = UserAccessTimesComponent.create(
    {
      createdAt: opts?.created || new Date(),
      updatedAt: opts?.updated || new Date(),
    },
    componentsGroup,
  );
  roomyObject.components[UserAccessTimesComponent.id] = userAccessTimes.id;

  const hiddenIn = HiddenInComponent.create(
    {
      hiddenIn: co.list(z.string()).create([]),
    },
    componentsGroup,
  );
  roomyObject.components[HiddenInComponent.id] = hiddenIn.id;

  if (opts?.replyTo) {
    roomyObject.components[ReplyToComponent.id] = opts?.replyTo;
  }

  const reactions = ReactionsComponent.create(
    {
      reactions: ReactionList.create([]),
    },
    reactionsGroup,
  );
  roomyObject.components[ReactionsComponent.id] = reactions.id;

  if (opts?.embeds && opts.embeds.length > 0) {
    const embedsGroup = Group.create();
    embedsGroup.addMember(publicReadGroup!, "reader");
    let embedsList = co.list(Embed).create([], embedsGroup);
    for (const embed of opts.embeds) {
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
    const embeds = EmbedsComponent.create(
      {
        embeds: embedsList,
      },
      embedsGroup,
    );

    // only add embeds component if there are any embeds
    roomyObject.components[EmbedsComponent.id] = embeds.id;
  }

  // skip AuthorComponent and ThreadIdComponent - can be added later if needed

  return { roomyObject, content, hiddenIn, reactions, componentsGroup };
}

export function messageHasAdmin(
  message: co.loaded<typeof RoomyEntity>,
  admin: co.loaded<typeof Account>,
) {
  if (!admin) return false;
  return admin.canAdmin(message);
}
