import { backend, backendStatus } from "$lib/workers";
import type { EventType, StreamHashId } from "$lib/workers/types";
import type { Did } from "@atproto/api";
import { toast } from "@fuxui/base";
import { ulid } from "ulidx";

/**
 * Join a space.
 */
export async function joinSpace(spaceId: StreamHashId) {
  try {
    if (backendStatus.authState?.state !== "authenticated") {
      toast.error("Could not join space. It's possible it does not exist.");
      return;
    }

    // Add the space to the personal list of joined spaces
    await backend.sendEvent(backendStatus.authState.personalStream, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.space.join.0",
        data: {
          spaceId: spaceId,
        },
      },
    });
    // Tell the space that we joined.
    await backend.sendEvent(spaceId, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.room.join.0",
        data: undefined,
      },
    });
  } catch (e) {
    console.error(e);
    toast.error("Could not join space. It's possible it does not exist.");
  }
}

export async function createSpace(opts: {
  spaceName: string;
  spaceDescription?: string;
  avatarFile?: File;
  creator: {
    did: Did;
    personalStreamId: StreamHashId;
  };
}) {
  let currentSpaceName = opts.spaceName;
  let currentSpaceDescription = opts.spaceDescription;

  if (!currentSpaceName) {
    throw "Please enter a name for the space";
  }

  // Create a new stream for the space
  const spaceId = await backend.createSpaceStream();

  console.log("created space", spaceId);

  // Join the space
  await backend.sendEvent(opts.creator.personalStreamId, {
    ulid: ulid(),
    parent: undefined,
    variant: {
      kind: "space.roomy.space.join.0",
      data: {
        spaceId,
      },
    },
  });

  console.log("sent join space event to personal stream");

  const avatarUpload =
    opts.avatarFile &&
    (await backend.uploadToPds(await opts.avatarFile.arrayBuffer()));

  const batch: EventType[] = [];

  // Update space info
  batch.push({
    ulid: ulid(),
    parent: undefined,
    variant: {
      kind: "space.roomy.info.0",
      data: {
        avatar: avatarUpload?.uri
          ? { set: avatarUpload.uri }
          : { ignore: undefined },
        name: currentSpaceName
          ? { set: currentSpaceName }
          : { ignore: undefined },
        description: currentSpaceDescription
          ? { set: currentSpaceDescription }
          : { ignore: undefined },
      },
    },
  });

  // Make this user and admin
  batch.push({
    ulid: ulid(),
    parent: undefined,
    variant: {
      kind: "space.roomy.admin.add.0",
      data: {
        adminId: opts.creator.did,
      },
    },
  });

  // Create the "system" user as the space itself
  batch.push({
    ulid: ulid(),
    parent: undefined,
    variant: {
      kind: "space.roomy.user.overrideMeta.0",
      data: {
        handle: "system",
      },
    },
  });

  const categoryId = ulid();
  batch.push({
    ulid: categoryId,
    parent: undefined,
    variant: {
      kind: "space.roomy.room.create.0",
      data: undefined,
    },
  });
  batch.push({
    ulid: ulid(),
    parent: categoryId,
    variant: {
      kind: "space.roomy.info.0",
      data: {
        name: { set: "Uncategorized" },
        avatar: { ignore: undefined },
        description: { ignore: undefined },
      },
    },
  });
  batch.push({
    ulid: ulid(),
    parent: categoryId,
    variant: {
      kind: "space.roomy.category.mark.0",
      data: undefined,
    },
  });
  const generalChannelId = ulid();
  batch.push({
    ulid: generalChannelId,
    parent: categoryId,
    variant: {
      kind: "space.roomy.room.create.0",
      data: undefined,
    },
  });
  batch.push({
    ulid: ulid(),
    parent: generalChannelId,
    variant: {
      kind: "space.roomy.info.0",
      data: {
        name: { set: "general" },
        avatar: { ignore: undefined },
        description: { ignore: undefined },
      },
    },
  });
  batch.push({
    ulid: ulid(),
    parent: generalChannelId,
    variant: {
      kind: "space.roomy.channel.mark.0",
      data: undefined,
    },
  });
  batch.push({
    ulid: ulid(),
    parent: generalChannelId,
    variant: {
      kind: "space.roomy.channel.mark.0",
      data: undefined,
    },
  });
  const welcomeThreadId = ulid();
  batch.push({
    ulid: welcomeThreadId,
    parent: generalChannelId,
    variant: {
      kind: "space.roomy.room.create.0",
      data: undefined,
    },
  });
  batch.push({
    ulid: ulid(),
    parent: welcomeThreadId,
    variant: {
      kind: "space.roomy.info.0",
      data: {
        name: { set: `Welcome to ${currentSpaceName}!` },
        avatar: { ignore: undefined },
        description: { ignore: undefined },
      },
    },
  });
  batch.push({
    ulid: ulid(),
    parent: welcomeThreadId,
    variant: {
      kind: "space.roomy.thread.mark.0",
      data: undefined,
    },
  });
  const welcomeMessageId = ulid();
  batch.push({
    ulid: welcomeMessageId,
    parent: welcomeThreadId,
    variant: {
      kind: "space.roomy.message.create.0",
      data: {
        replyTo: undefined,
        content: {
          mimeType: "text/markdown",
          content: new TextEncoder().encode(`Welcome to your new Roomy space!`),
        },
      },
    },
  });
  batch.push({
    ulid: ulid(),
    parent: welcomeMessageId,
    variant: {
      kind: "space.roomy.message.overrideMeta.0",
      data: {
        author: spaceId,
        timestamp: BigInt(Date.now()),
      },
    },
  });

  await backend.sendEventBatch(spaceId, batch);

  console.log("sent events batch");

  return { spaceId };
}
