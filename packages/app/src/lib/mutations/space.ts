import { backend, backendStatus } from "$lib/workers";
import type { Event, StreamDid, Did } from "@roomy/sdk";
import { toast } from "@fuxui/base";
import { newUlid, ulidFactory } from "@roomy/sdk";

/**
 * Join a space.
 */
export async function joinSpace(spaceId: StreamDid) {
  try {
    if (backendStatus.roomyState?.state !== "connected") {
      toast.error("Could not join space. It's possible it does not exist.");
      return;
    }

    // Add the space to the personal list of joined spaces
    await backend.sendEvent(backendStatus.roomyState.personalSpace, {
      id: newUlid(),
      $type: "space.roomy.space.personal.joinSpace.v0",
      spaceDid: spaceId,
    });

    await backend.connectPendingSpaces();

    // Tell the space that we joined.
    await backend.sendEvent(spaceId, {
      id: newUlid(),
      $type: "space.roomy.space.joinSpace.v0",
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
    $type: "space.roomy.space.personal.joinSpace.v0",
    spaceDid: spaceDid,
  });

  console.log("sent join space event to personal stream");

  const avatarUpload =
    opts.avatarFile &&
    (await backend.uploadToPds(await opts.avatarFile.arrayBuffer()));

  const batch: Event[] = [];

  // Update space info
  batch.push({
    id: newUlid(),
    $type: "space.roomy.space.updateSpaceInfo.v0",
    avatar: avatarUpload?.uri,
    name: currentSpaceName,
    description: currentSpaceDescription,
  });

  // Create the "system" user as the space itself
  batch.push({
    id: newUlid(),
    $type: "space.roomy.user.updateProfile.v0",
    did: spaceDid,
    name: "system",
  });

  const generalChannelId = newUlid();
  batch.push({
    id: generalChannelId,
    $type: "space.roomy.room.createRoom.v0",
    kind: "space.roomy.channel",
    name: "lobby",
  });

  batch.push({
    id: newUlid(),
    $type: "space.roomy.space.updateSidebar.v0",
    categories: [
      {
        name: "general",
        children: [generalChannelId],
      },
    ],
  });

  await backend.sendEventBatch(spaceDid, batch);

  console.log("sent events batch", batch);

  return { spaceDid };
}
