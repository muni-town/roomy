import { backend, backendStatus } from "$lib/workers";
import type { Event, StreamDid, Did } from "$lib/schema";
import { toast } from "@fuxui/base";
import { newUlid, ulidFactory } from "$lib/schema";

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
      variant: {
        $type: "space.roomy.space.personal.joinSpace.v0",
        spaceDid: spaceId,
      },
    });
    // Tell the space that we joined.
    await backend.sendEvent(spaceId, {
      id: newUlid(),
      variant: {
        $type: "space.roomy.space.joinSpace.v0",
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

  const newUlid = ulidFactory();

  if (!currentSpaceName) {
    throw "Please enter a name for the space";
  }

  // Create a new stream for the space
  const spaceDid = await backend.createSpaceStream();

  console.log("created space", spaceDid);

  // Join the space
  await backend.sendEvent(opts.creator.personalStreamId, {
    id: newUlid(),
    variant: {
      $type: "space.roomy.space.personal.joinSpace.v0",
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
      $type: "space.roomy.space.updateSpaceInfo.v0",
      avatar: avatarUpload?.uri,
      name: currentSpaceName,
      description: currentSpaceDescription,
    },
  });

  // Create the "system" user as the space itself
  batch.push({
    id: newUlid(),
    variant: {
      $type: "space.roomy.user.overrideHandle.v0",
      handle: "system",
      did: spaceDid,
    },
  });

  const generalChannelId = newUlid();
  batch.push({
    id: generalChannelId,
    variant: {
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.channel",
      name: "lobby",
    },
  });

  batch.push({
    id: newUlid(),
    variant: {
      $type: "space.roomy.space.updateSidebar.v0",
      categories: [
        {
          name: "general",
          children: [generalChannelId],
        },
      ],
    },
  });

  await backend.sendEventBatch(spaceDid, batch);

  console.log("sent events batch", batch);

  return { spaceDid };
}
