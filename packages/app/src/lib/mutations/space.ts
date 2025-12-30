import { backend, backendStatus } from "$lib/workers";
import type { Event, StreamDid, Did } from "$lib/schema";
import { toast } from "@fuxui/base";
import { newUlid, toBytes } from "$lib/schema";

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
        $type: "space.roomy.stream.personal.joinSpace.v0",
        spaceDid: spaceId,
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
  const spaceDid = await backend.createSpaceStream();

  console.log("created space", spaceDid);

  // Join the space
  await backend.sendEvent(opts.creator.personalStreamId, {
    id: newUlid(),
    room: undefined,
    variant: {
      $type: "space.roomy.stream.personal.joinSpace.v0",
      spaceDid: spaceDid,
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
    variant: {
      $type: "space.roomy.stream.updateStreamInfo.v0",
      avatar: avatarUpload?.uri,
      name: currentSpaceName,
      description: currentSpaceDescription,
    },
  });

  // Create the "system" user as the space itself
  batch.push({
    id: newUlid(),
    room: undefined,
    variant: {
      $type: "space.roomy.user.overrideHandle.v0",
      handle: "system",
      did: spaceDid,
    },
  });

  const categoryId = newUlid();
  batch.push({
    id: categoryId,
    room: undefined,
    variant: {
      $type: "space.roomy.room.createRoom.v0",
      kind: "category",
      // FIXME: we should not have a category named uncategorized, we should just display .
      name: "Uncategorized",
    },
  });
  const generalChannelId = newUlid();
  batch.push({
    id: generalChannelId,
    room: categoryId,
    variant: {
      $type: "space.roomy.room.createRoom.v0",
      kind: "channel",
      name: "general",
    },
  });
  const welcomeMessageId = newUlid();
  batch.push({
    id: welcomeMessageId,
    room: generalChannelId,
    variant: {
      $type: "space.roomy.message.sendMessage.v0",
      body: {
        mimeType: "text/markdown",
        data: toBytes(
          new TextEncoder().encode(`Welcome to your new Roomy space!`),
        ),
      },
      extensions: {
        "space.roomy.extension.authorOverride.v0": {
          did: spaceDid,
        },
      },
    },
  });

  await backend.sendEventBatch(spaceDid, batch);

  console.log("sent events batch", batch);

  return { spaceDid };
}
