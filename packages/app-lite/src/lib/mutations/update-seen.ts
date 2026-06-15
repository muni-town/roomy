import { px } from "$lib/auth.svelte";

export async function updateSeen(
  roomId: string,
  seenUpTo?: string,
): Promise<void> {
  await px().procedure("space.roomy.room.updateSeen", {
    roomId,
    ...(seenUpTo ? { seenUpTo } : {}),
  });
}
