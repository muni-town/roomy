import { backend, backendStatus } from "$lib/workers";
import type { EventType, DidStream } from "$lib/workers/types";
import type { Did } from "@atproto/api";
import { toast } from "@fuxui/base";
import { newUlid } from "$lib/schema";

/**
 * Join a space.
 */
export async function joinSpace(spaceId: DidStream) {
  try {
    if (backendStatus.authState?.state !== "authenticated") {
      toast.error("Could not join space. It's possible it does not exist.");
      return;
    }

    // Add the space to the personal list of joined spaces
    await backend.sendEvent(backendStatus.authState.personalStream, {
      ulid: newUlid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.personal.joinSpace.v0",
        data: {
          spaceId: spaceId,
        },
      },
    });
    // Tell the space that we joined.
    await backend.sendEvent(spaceId, {
      ulid: newUlid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.room.joinRoom.v0",
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
    personalStreamId: DidStream;
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
    ulid: newUlid(),
    parent: undefined,
    variant: {
      kind: "space.roomy.personal.joinSpace.v0",
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
    ulid: newUlid(),
    parent: undefined,
    variant: {
      kind: "space.roomy.info.v0",
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
    ulid: newUlid(),
    parent: undefined,
    variant: {
      kind: "space.roomy.space.addAdmin.v0",
      data: {
        adminId: opts.creator.did,
      },
    },
  });

  // Create the "system" user as the space itself
  batch.push({
    ulid: newUlid(),
    parent: undefined,
    variant: {
      kind: "space.roomy.space.overrideUserMeta.v0",
      data: {
        handle: "system",
      },
    },
  });

  const categoryId = newUlid();
  batch.push({
    ulid: categoryId,
    parent: undefined,
    variant: {
      kind: "space.roomy.room.createRoom.v0",
      data: undefined,
    },
  });
  batch.push({
    ulid: newUlid(),
    parent: categoryId,
    variant: {
      kind: "space.roomy.info.v0",
      data: {
        name: { set: "Uncategorized" },
        avatar: { ignore: undefined },
        description: { ignore: undefined },
      },
    },
  });
  batch.push({
    ulid: newUlid(),
    parent: categoryId,
    variant: {
      kind: "space.roomy.room.kind.v0",
      data: {
        kind: "space.roomy.category.v0",
        data: undefined,
      },
    },
  });
  const generalChannelId = newUlid();
  batch.push({
    ulid: generalChannelId,
    parent: categoryId,
    variant: {
      kind: "space.roomy.room.createRoom.v0",
      data: undefined,
    },
  });
  batch.push({
    ulid: newUlid(),
    parent: generalChannelId,
    variant: {
      kind: "space.roomy.info.v0",
      data: {
        name: { set: "general" },
        avatar: { ignore: undefined },
        description: { ignore: undefined },
      },
    },
  });
  batch.push({
    ulid: newUlid(),
    parent: generalChannelId,
    variant: {
      kind: "space.roomy.room.kind.v0",
      data: {
        kind: "space.roomy.channel.v0",
        data: undefined,
      },
    },
  });
  const welcomeThreadId = newUlid();
  batch.push({
    ulid: welcomeThreadId,
    parent: generalChannelId,
    variant: {
      kind: "space.roomy.room.createRoom.v0",
      data: undefined,
    },
  });
  batch.push({
    ulid: newUlid(),
    parent: welcomeThreadId,
    variant: {
      kind: "space.roomy.info.v0",
      data: {
        name: { set: `Welcome to ${currentSpaceName}!` },
        avatar: { ignore: undefined },
        description: { ignore: undefined },
      },
    },
  });
  batch.push({
    ulid: newUlid(),
    parent: welcomeThreadId,
    variant: {
      kind: "space.roomy.room.kind.v0",
      data: {
        kind: "space.roomy.thread.v0",
        data: undefined,
      },
    },
  });
  const welcomeMessageId = newUlid();
  batch.push({
    ulid: welcomeMessageId,
    parent: welcomeThreadId,
    variant: {
      kind: "space.roomy.room.sendMessage.v0",
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
    ulid: newUlid(),
    parent: welcomeMessageId,
    variant: {
      kind: "space.roomy.message.overrideMeta.v0",
      data: {
        author: spaceId,
        timestamp: BigInt(Date.now()),
      },
    },
  });

  await backend.sendEventBatch(spaceId, batch);

  console.log("sent events batch", batch);

  return { spaceId };
}
