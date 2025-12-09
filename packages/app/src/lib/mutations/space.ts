import { backend, backendStatus } from "$lib/workers";
import type { StreamHashId } from "$lib/workers/types";
import { toast } from "@fuxui/base";
import { ulid } from "ulidx";

/**
 * Join a space.
 */
export async function joinSpace(spaceId: StreamHashId) {
  try {
    if (backendStatus.authState?.state !== "authenticated") {
      toast.error("Could not join space. It's possible it does not exist.");
      return;
    }

    // Add the space to the personal list of joined spaces
    await backend.sendEvent(backendStatus.authState.personalStream, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.space.join.0",
        data: {
          spaceId: spaceId,
        },
      },
    });
    // Tell the space that we joined.
    await backend.sendEvent(spaceId, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.room.join.0",
        data: undefined,
      },
    });
  } catch (e) {
    console.error(e);
    toast.error("Could not join space. It's possible it does not exist.");
  }
}
