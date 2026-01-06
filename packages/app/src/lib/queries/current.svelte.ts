import { page } from "$app/state";
import { backend, backendStatus } from "$lib/workers";
import { joinedSpaces } from "./spaces.svelte";
import type { AuthStates } from "$lib/workers/backend/types";
import type { SpaceIdOrHandle } from "$lib/workers/types";
import type { SpaceMeta } from "./types";
import { type StreamDid, Ulid, type UserDid } from "$lib/schema";

type SpaceStatus =
  | { status: "no-current-space" }
  | { status: "loading"; spaceId?: SpaceIdOrHandle }
  | { status: "invited"; spaceId: StreamDid }
  | { status: "joined"; space: SpaceMeta; isSpaceAdmin: boolean }
  | {
      status: "error";
      message: string;
    };

// For Svelte reactivity we need to export a const object:
// mutate properties, never reassign the object itself
export const current = $state<{
  space: SpaceStatus;
  roomId: Ulid | undefined;
  did: UserDid | undefined;

  // derived from space
  joinedSpace: SpaceMeta | undefined;
  isSpaceAdmin: boolean;
}>({
  space: { status: "loading" },
  roomId: undefined,
  did: undefined,
  joinedSpace: undefined,
  isSpaceAdmin: false,
});
(globalThis as any).current = current;

function error(message: string) {
  console.error(message);
  current.space = { status: "error", message };
  current.joinedSpace = undefined;
  current.isSpaceAdmin = false;
}

async function getCurrentSpace(spaceId: SpaceIdOrHandle) {
  // Resolve the space handle to a space ID
  const resp = await backend.resolveSpaceId(spaceId as SpaceIdOrHandle);

  const exists = await backend.checkSpaceExists(resp.spaceId);
  if (!exists) {
    throw "This space doesn't exist or has been deleted.";
  }

  // Get the matching space locally, if we've already joined it
  const matchingSpace = resp.spaceId
    ? joinedSpaces.list?.find((x) => x.id == resp.spaceId)
    : undefined;
  if (!matchingSpace) {
    return { matchingSpace, spaceId: resp.spaceId, isSpaceAdmin: false };
  }

  // Make sure that the space actually has a handle
  const handleAccount = matchingSpace?.handle_account;
  if (handleAccount) {
    // Validate that the DID of the handle matches our handle account
    if (handleAccount != resp.did) {
      throw "This space's handle is registered to a different account.";
    }
  }

  const isSpaceAdmin =
    matchingSpace.permissions?.some(
      (permission) =>
        permission[0] ===
          (backendStatus.authState as AuthStates.ReactiveAuthenticated).did &&
        permission[1] === "admin",
    ) || false;
  return { matchingSpace, spaceId: resp.spaceId, isSpaceAdmin };
}

$effect.root(() => {
  // Update current.space whenever page.params.space or joinedSpaces change
  $effect(() => {
    page.params.space; // depend on page.params.space

    // console.log("current space", page.params.space);

    // TODO: when we checked if the space was loading right here it would cause a problem when
    // we start lazy loading a room, because we go from a loaded space to a loading space, and
    // once the space was loaded it would change the space and trigger another lazy load in an
    // infinite loop.
    //
    // For unknown reasons this mostly happened on threads or rooms without any messages in
    // them yet.

    // if (joinedSpaces.loading || !page.params.space) return; // wait until spaces are loaded
    if (!page.params.space) return;

    getCurrentSpace(page.params.space as SpaceIdOrHandle)
      .then(({ matchingSpace, isSpaceAdmin, spaceId }) => {
        current.space = matchingSpace
          ? {
              status: "joined",
              space: matchingSpace,
              isSpaceAdmin,
            }
          : {
              status: "invited",
              spaceId: spaceId,
            };
        current.joinedSpace = matchingSpace;
        current.isSpaceAdmin = isSpaceAdmin;
      })
      .catch(error);

    // reset when space changes
    return () => {
      current.space = { status: "no-current-space" };
      current.joinedSpace = undefined;
      current.isSpaceAdmin = false;
    };
  });

  // Update current.roomId whenever page params change
  $effect(() => {
    page.params.object;
    // console.log("room", page.params.object);
    if (!page.params.object || !Ulid.allows(page.params.object)) return;
    current.roomId = Ulid.assert(page.params.object);

    // reset when room changes
    return () => {
      current.roomId = undefined;
    };
  });

  $effect(() => {
    current.did =
      backendStatus.authState?.state === "authenticated"
        ? backendStatus.authState.did
        : undefined;
  });
});
