import { px } from "$lib/auth.svelte";

/**
 * Ask the appserver to reinstall the latest arbiter policy on a space's
 * stewarded account. Requires admin access on the space. The appserver acts
 * as the arbiter's recovery admin to push the current default policy.
 *
 * When the arbiter is not configured (no `ARBITER_URL`), the appserver treats
 * the call as a no-op success. When it is configured, the appserver attempts
 * `resetPolicy` for the space and surfaces any arbiter error (e.g. an
 * un-stewarded/legacy space) to the caller.
 */
export async function updatePolicy(spaceId: string): Promise<void> {
  await px().procedure("space.roomy.space.updatePolicy", { spaceId });
}
