import { launchConfetti } from "@fuxui/visual";
import type { co, RoomyAccount, Space } from "@roomy-chat/sdk";

export function joinSpace(
  space: co.loaded<typeof Space> | undefined | null,
  me: co.loaded<typeof RoomyAccount> | undefined | null,
) {
  if (!space || !me) return;

  // add to my list of joined spaces
  me.profile?.joinedSpaces?.push(space);

  // add to space.current.members
  space.members?.push(me);

  launchConfetti();
}
