import { peer, peerStatus } from "$lib/workers";
import type { StreamDid, Did } from "@roomy/sdk";
import { toast } from "@fuxui/base";
import { newUlid, createDefaultSpaceEvents } from "@roomy/sdk";

/**
 * Join a space.
 */
export async function joinSpace(spaceId: StreamDid) {
  try {
    if (peerStatus.roomyState?.state !== "connected") {
      toast.error("Could not join space. It's possible it does not exist.");
      return;
    }

    // Add the space to the personal list of joined spaces
    await peer.sendEvent(peerStatus.roomyState.personalSpace, {
      id: newUlid(),
      $type: "space.roomy.space.personal.joinSpace.v0",
      spaceDid: spaceId,
    });

    await peer.connectPendingSpaces();

    // Tell the space that we joined.
    await peer.sendEvent(spaceId, {
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
  if (!opts.spaceName) {
    throw "Please enter a name for the space";
  }

  // Create a new stream for the space
  const spaceDid = await peer.createSpaceStream();

  console.log("created space", spaceDid);

  // Join the space
  await peer.sendEvent(opts.creator.personalStreamId, {
    id: newUlid(),
    $type: "space.roomy.space.personal.joinSpace.v0",
    spaceDid: spaceDid,
  });

  console.log("sent join space event to personal stream");

  // Upload avatar if provided
  const avatarUpload =
    opts.avatarFile &&
    (await peer.uploadToPds(await opts.avatarFile.arrayBuffer()));

  // Create default space events using SDK helper
  // This creates: space info, lobby channel, and sidebar with general category
  const defaultSpaceEvents = createDefaultSpaceEvents({
    name: opts.spaceName,
    description: opts.spaceDescription,
    avatar: avatarUpload?.uri,
  });

  await peer.sendEventBatch(spaceDid, defaultSpaceEvents);

  console.log("sent default space events", defaultSpaceEvents);

  return { spaceDid };
}
