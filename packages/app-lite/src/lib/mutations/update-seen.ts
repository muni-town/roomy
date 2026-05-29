import { transport } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { agentProcedure } = transport;

export async function updateSeen(
  roomId: string,
  seenUpTo?: string,
): Promise<void> {
  await agentProcedure(px(), "space.roomy.room.updateSeen", {
    roomId,
    ...(seenUpTo ? { seenUpTo } : {}),
  });
}
