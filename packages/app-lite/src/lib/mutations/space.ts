import { newUlid } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";

export async function joinSpace(
  spaceId: string,
  inviteToken?: string,
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.space.joinSpace.v0",
      ...(inviteToken ? { inviteToken } : {}),
    },
  ]);
}
