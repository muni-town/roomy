import { Account, co, Group, z } from "jazz-tools";
import {
  CommonMarkContentComponent,
  Embed,
  EmbedsComponent,
  HiddenInComponent,
  ImageUrlEmbed,
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
import {
  addComponent,
  LoadedSpaceGroups,
  RoomyEntity,
} from "../schema/index.js";

export async function createThread(
  name: string,
  groups: LoadedSpaceGroups,
): Promise<{
  entity: co.loaded<typeof RoomyEntity, { components: true }>;
  thread: co.loaded<typeof ThreadComponent, { timeline: true }>;
  subThreads: co.loaded<typeof SubThreadsComponent>;
}> {
  const entity = await createRoomyEntity(name, groups.admin);
  const thread = await addComponent(
    entity,
    ThreadComponent,
    {
      timeline: Timeline.create([], groups.public),
    },
    groups.admin,
  );
  const subThreads = await addComponent(
    entity,
    SubThreadsComponent,
    [],
    groups.public,
  );

  return { entity, thread, subThreads };
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
  embeds?: (ImageUrlEmbedCreate | VideoUrlEmbedCreate)[];
  created?: Date;
  updated?: Date;
}

export async function createMessage(
  input: string,
  group: Group,
  opts: CreateMessageOptions,
) {
  const entity = await createRoomyEntity("", group);
  const commonMark = await addComponent(
    entity,
    CommonMarkContentComponent,
    { content: input },
    group,
  );
  const userAccessTimes = await addComponent(
    entity,
    UserAccessTimesComponent,
    {
      createdAt: opts?.created || new Date(),
      updatedAt: opts?.updated || new Date(),
    },
    group,
  );
  const hiddenIn = await addComponent(entity, HiddenInComponent, {
    hiddenIn: co.list(z.string()).create([]),
  });
  if (opts?.replyTo) {
    entity.components[ReplyToComponent.id] = opts?.replyTo;
  }
  const reactions = await addComponent(
    entity,
    ReactionsComponent,
    { reactions: ReactionList.create([]) },
    group,
  );

  let embeds;
  if (opts?.embeds && opts.embeds.length > 0) {
    let embedsList = co.list(Embed).create([], group);

    for (const embed of opts.embeds) {
      if (embed.type === "imageUrl") {
        const imageUrlEmbed = ImageUrlEmbed.create(
          { url: embed.data.url },
          group,
        );

        embedsList.push(
          Embed.create({ type: "imageUrl", embedId: imageUrlEmbed.id }, group),
        );
      } else if (embed.type === "videoUrl") {
        const videoUrlEmbed = VideoUrlEmbed.create(
          { url: embed.data.url },
          group,
        );
        embedsList.push(
          Embed.create({ type: "videoUrl", embedId: videoUrlEmbed.id }, group),
        );
      }
    }
    embeds = await addComponent(
      entity,
      EmbedsComponent,
      { embeds: embedsList },
      group,
    );
  }

  return { entity, commonMark, hiddenIn, reactions, userAccessTimes, embeds };
}

export function messageHasAdmin(
  message: co.loaded<typeof RoomyEntity>,
  admin: co.loaded<typeof Account>,
) {
  if (!admin) return false;
  return admin.canAdmin(message);
}
