import {
  getSpaceProfileRecord,
  putProfileRecord,
} from "@roomy-space/sdk";
import { auth } from "$lib/auth.svelte";
import { createArbiterClient } from "$lib/arbiter";

/**
 * Read/write a space's Bluesky profile (app.bsky.actor.profile).
 *
 * Reads go straight to the space's PDS via the `atproto-proxy` header (public
 * data, no auth). Writes go through the space's arbiter — discovered per space
 * from its `town.muni.arbiter.service` record — via the arbiter's `proxy`
 * procedure, whose Rego policy grants Roomy space admins the ability to write
 * records under the space's account.
 *
 * Returns `hasProfile: false` when the space has no Bluesky profile record
 * yet, so the UI can show "Create" vs "Update".
 */
export interface SpaceBlueskyProfileState {
  hasProfile: boolean;
  displayName: string | null;
  description: string | null;
}

/** Fetch the space's current Bluesky profile state (direct PDS read). */
export async function getBlueskyProfile(
  spaceId: string,
): Promise<SpaceBlueskyProfileState> {
  const agent = auth.agent;
  if (!agent) throw new Error("Not authenticated");
  const record = await getSpaceProfileRecord(agent, spaceId);
  if (!record) return { hasProfile: false, displayName: null, description: null };
  return {
    hasProfile: true,
    displayName: record.displayName ?? null,
    description: record.description ?? null,
  };
}

/**
 * Create or update the space's Bluesky profile using the space's name and
 * description. The space's description comes from the caller (the current
 * space metadata) so we don't round-trip it separately.
 */
export async function upsertBlueskyProfile(
  spaceId: string,
  opts: { displayName?: string; description?: string },
): Promise<void> {
  const arbiter = createArbiterClient();
  await putProfileRecord(arbiter, spaceId, {
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
    ...(opts.description ? { description: opts.description } : {}),
  });
}
