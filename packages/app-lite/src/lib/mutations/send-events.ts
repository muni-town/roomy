import { px } from "$lib/auth.svelte";

/**
 * Send a batch of Roomy events to a space via the appserver.
 * Caller must provide a fully-formed event (with `id` and `extensions`).
 */
export async function sendEvents(
  spaceId: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  await px().procedure("space.roomy.space.sendEvents", {
    spaceId,
    events,
  });
}
