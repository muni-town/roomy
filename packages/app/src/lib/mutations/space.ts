import { peer, peerStatus } from "$lib/workers";
import type { StreamDid, Did } from "@roomy-space/sdk";
import { newUlid, createDefaultSpaceEvents } from "@roomy-space/sdk";

/**
 * Join a space.
 * @param inviteToken - Required for private spaces (allow_public_join = false)
 * @throws if not connected or if the server rejects the join (e.g. invalid invite token)
 */
export async function joinSpace(spaceId: StreamDid, inviteToken?: string) {
  if (peerStatus.roomyState?.state !== "connected") {
    throw new Error("Not connected. Please try again.");
  }

  // Add the space to the personal list of joined spaces
  await peer.sendEvent(peerStatus.roomyState.personalSpace, {
    id: newUlid(),
    $type: "space.roomy.space.personal.joinSpace.v0",
    spaceDid: spaceId,
  });

  await peer.connectPendingSpaces();

  // Tell the space that we joined.
  // This will throw if the server rejects the event (e.g. invalid invite token).
  await peer.sendEvent(spaceId, {
    id: newUlid(),
    $type: "space.roomy.space.joinSpace.v0",
    ...(inviteToken ? { inviteToken } : {}),
  });
}

export async function createSpace(opts: {
  spaceName: string;
  spaceDescription?: string;
  avatarFile?: File;
  allowPublicJoin?: boolean;
  allowMemberInvites?: boolean;
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
    allowPublicJoin: opts.allowPublicJoin,
    allowMemberInvites: opts.allowMemberInvites,
  });

  await peer.sendEventBatch(spaceDid, defaultSpaceEvents);
  console.log("sent default space events", defaultSpaceEvents);

  // Join the space
  await peer.sendEvent(opts.creator.personalStreamId, {
    id: newUlid(),
    $type: "space.roomy.space.personal.joinSpace.v0",
    spaceDid: spaceDid,
  });
  console.log("sent join space event to personal stream");

  return { spaceDid };
}
