import { page } from "$app/state";
import { backend, backendStatus } from "$lib/workers";
import type { AuthStates } from "$lib/workers/backend/types";
import type { SpaceIdOrHandle, StreamHashId } from "$lib/workers/types";
import type { Did } from "@atproto/api";
import { joinedSpaces } from "./spaces.svelte";
import type { SpaceMeta } from "./types";

type SpaceStatus =
  | { status: "loading"; spaceId?: SpaceIdOrHandle }
  | { status: "invited"; spaceId: StreamHashId }
  | { status: "joined"; space: SpaceMeta; isSpaceAdmin: boolean }
  | {
      status: "error";
      message: string;
    };

// For Svelte reactivity we need to export a const object:
// mutate properties, never reassign the object itself
export const current = $state<{
  space: SpaceStatus;
  roomId: string | undefined;
  did: Did | undefined;

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
    current.space = {
      status: "invited",
      spaceId: resp.spaceId,
    };
    current.joinedSpace = undefined;
    current.isSpaceAdmin = false;
    throw "You have not joined this space yet.";
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
  return { matchingSpace, isSpaceAdmin };
}

$effect.root(() => {
  // Update current.space whenever page.params.space or joinedSpaces change
  $effect(() => {
    page.params.space; // depend on page.params.space

    // console.log("current", current.space);

    if (joinedSpaces.loading) return; // wait until spaces are loaded

    if (!page.params.space) {
      error("No space ID or handle provided");
      return;
    }

    getCurrentSpace(page.params.space as SpaceIdOrHandle)
      .then(({ matchingSpace, isSpaceAdmin }) => {
        current.space = {
          status: "joined",
          space: matchingSpace,
          isSpaceAdmin,
        };
        current.joinedSpace = matchingSpace;
        current.isSpaceAdmin = isSpaceAdmin;
      })
      .catch(error);
  });

  // Update current.roomId whenever page params change
  $effect(() => {
    page.params.object;
    current.roomId = page.params.object;
  });

  $effect(() => {
    current.did =
      backendStatus.authState?.state === "authenticated"
        ? backendStatus.authState.did
        : undefined;
  });
});
