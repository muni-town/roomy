import { backend, backendStatus } from "$lib/workers";
import type { Event, StreamDid, Did } from "$lib/schema";
import { toast } from "@fuxui/base";
import { ignore, newUlid, set, toBytes } from "$lib/schema";

/**
 * Join a space.
 */
export async function joinSpace(spaceId: StreamDid) {
  try {
    if (backendStatus.authState?.state !== "authenticated") {
      toast.error("Could not join space. It's possible it does not exist.");
      return;
    }

    // Add the space to the personal list of joined spaces
    await backend.sendEvent(backendStatus.authState.personalStream, {
      id: newUlid(),
      room: undefined,
      variant: {
        $type: "space.roomy.personal.joinSpace.v0",
        spaceId: spaceId,
      },
    });
    // Tell the space that we joined.
    await backend.sendEvent(spaceId, {
      id: newUlid(),
      room: undefined,
      variant: {
        $type: "space.roomy.room.joinRoom.v0",
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
    personalStreamId: StreamDid;
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
    id: newUlid(),
    room: undefined,
    variant: {
      $type: "space.roomy.personal.joinSpace.v0",
      spaceId,
    },
  });

  console.log("sent join space event to personal stream");

  const avatarUpload =
    opts.avatarFile &&
    (await backend.uploadToPds(await opts.avatarFile.arrayBuffer()));

  const batch: Event[] = [];

  // Update space info
  batch.push({
    id: newUlid(),
    room: undefined,
    variant: {
      $type: "space.roomy.common.setInfo.v0",
      avatar: avatarUpload?.uri ? set(avatarUpload.uri) : ignore,
      name: currentSpaceName ? set(currentSpaceName) : ignore,
      description: currentSpaceDescription
        ? set(currentSpaceDescription)
        : ignore,
    },
  });

  // Create the "system" user as the space itself
  batch.push({
    id: newUlid(),
    room: undefined,
    variant: {
      $type: "space.roomy.space.overrideUserMeta.v0",
      handle: "system",
      target: spaceId,
    },
  });

  const categoryId = newUlid();
  batch.push({
    id: categoryId,
    room: undefined,
    variant: {
      $type: "space.roomy.room.createRoom.v0",
    },
  });
  batch.push({
    id: newUlid(),
    room: categoryId,
    variant: {
      $type: "space.roomy.common.setInfo.v0",
      name: set("Uncategorized"),
      avatar: ignore,
      description: ignore,
    },
  });
  batch.push({
    id: newUlid(),
    room: categoryId,
    variant: {
      $type: "space.roomy.room.setKind.v0",
      kind: "category",
    },
  });
  const generalChannelId = newUlid();
  batch.push({
    id: generalChannelId,
    room: categoryId,
    variant: {
      $type: "space.roomy.room.createRoom.v0",
    },
  });
  batch.push({
    id: newUlid(),
    room: generalChannelId,
    variant: {
      $type: "space.roomy.common.setInfo.v0",
      name: set("general"),
      avatar: ignore,
      description: ignore,
    },
  });
  batch.push({
    id: newUlid(),
    room: generalChannelId,
    variant: {
      $type: "space.roomy.room.setKind.v0",
      kind: "channel",
    },
  });
  const welcomeThreadId = newUlid();
  batch.push({
    id: welcomeThreadId,
    room: generalChannelId,
    variant: {
      $type: "space.roomy.room.createRoom.v0",
    },
  });
  batch.push({
    id: newUlid(),
    room: welcomeThreadId,
    variant: {
      $type: "space.roomy.common.setInfo.v0",
      name: set(`Welcome to ${currentSpaceName}!`),
      avatar: ignore,
      description: ignore,
    },
  });
  batch.push({
    id: newUlid(),
    room: welcomeThreadId,
    variant: {
      $type: "space.roomy.room.setKind.v0",
      kind: "thread",
    },
  });
  const welcomeMessageId = newUlid();
  batch.push({
    id: welcomeMessageId,
    room: welcomeThreadId,
    variant: {
      $type: "space.roomy.room.sendMessage.v0",
      body: {
        mimeType: "text/markdown",
        data: toBytes(
          new TextEncoder().encode(`Welcome to your new Roomy space!`),
        ),
      },
      extensions: {
        "space.roomy.extension.authorOverride.v0": {
          did: spaceId,
        },
      },
    },
  });

  await backend.sendEventBatch(spaceId, batch);

  console.log("sent events batch", batch);

  return { spaceId };
}
