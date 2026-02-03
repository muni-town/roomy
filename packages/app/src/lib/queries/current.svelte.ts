import { page } from "$app/state";
import { peer, peerStatus } from "$lib/workers";
import { joinedSpaces } from "./spaces.svelte";
import type { AuthStatus } from "$lib/workers/peer/types";
import type { SpaceIdOrHandle } from "$lib/workers/types";
import type { SpaceMeta } from "./types";
import { Handle, type StreamDid, Ulid, type UserDid } from "@roomy/sdk";
import { SvelteMap } from "svelte/reactivity";

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

let resolvedSpaceIds = new SvelteMap<
  string,
  | {
      spaceId: StreamDid;
      handle?: Handle;
    }
  | { error: string }
>();

let resolvedSpaceExists = new SvelteMap<StreamDid, boolean>();

function error(message: string) {
  console.error(message);
  current.space = { status: "error", message };
  current.joinedSpace = undefined;
  current.isSpaceAdmin = false;
}

const currentSpace = $derived.by(() => {
  // Resolve the space handle to a space ID
  const spaceUrlSegment = page.params.space;
  if (!spaceUrlSegment) return undefined;
  if (!resolvedSpaceIds.has(spaceUrlSegment)) {
    peer.resolveSpaceId(spaceUrlSegment as SpaceIdOrHandle).then((resp) => {
      resolvedSpaceIds.set(spaceUrlSegment, resp);
    });
    return undefined;
  }
  const resp = resolvedSpaceIds.get(spaceUrlSegment);

  if (!resp || !("spaceId" in resp)) return undefined;
  if (!resolvedSpaceExists.has(resp.spaceId)) {
    peer.checkSpaceExists(resp.spaceId).then((exists) => {
      resolvedSpaceExists.set(resp.spaceId, exists);
    });
    return undefined;
  }
  const exists = resolvedSpaceExists.get(resp.spaceId);
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

  const isSpaceAdmin =
    matchingSpace.permissions?.some(
      (permission) =>
        permission[0] ===
          (
            peerStatus.authState as Extract<
              AuthStatus,
              { state: "authenticated" }
            >
          ).did && permission[1] === "admin",
    ) || false;
  return { matchingSpace, spaceId: resp.spaceId, isSpaceAdmin };
});

$effect.root(() => {
  // Update current.space whenever page.params.space or joinedSpaces change
  $effect(() => {
    // TODO: when we checked if the space was loading right here it would cause a problem when
    // we start lazy loading a room, because we go from a loaded space to a loading space, and
    // once the space was loaded it would change the space and trigger another lazy load in an
    // infinite loop.
    //
    // For unknown reasons this mostly happened on threads or rooms without any messages in
    // them yet.

    if (joinedSpaces.loading || !page.params.space) return; // wait until spaces are loaded
    if (
      peerStatus.authState?.state !== "authenticated" ||
      peerStatus.roomyState?.state !== "connected" ||
      !currentSpace
    )
      return;

    current.space = currentSpace.matchingSpace
      ? {
          status: "joined",
          space: currentSpace.matchingSpace,
          isSpaceAdmin: currentSpace?.isSpaceAdmin,
        }
      : {
          status: "invited",
          spaceId: currentSpace.spaceId,
        };
    current.joinedSpace = currentSpace.matchingSpace;
    current.isSpaceAdmin = currentSpace.isSpaceAdmin;

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
      peerStatus.authState?.state === "authenticated"
        ? peerStatus.authState.did
        : undefined;
  });
});
