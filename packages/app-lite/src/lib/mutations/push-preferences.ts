import { px } from "$lib/auth.svelte";

export type PushLevel = "silent" | "quiet" | "engaged" | "busy";

/**
 * Set the user-wide default notification level.
 * (Use {@link setSpacePushLevel} for a per-space override.)
 */
export async function setDefaultPushLevel(level: PushLevel): Promise<void> {
  await px().procedure("space.roomy.push.setPreferences", { default: level });
}

/**
 * Set (or override) the per-space notification level for a space.
 */
export async function setSpacePushLevel(
  spaceId: string,
  level: PushLevel,
): Promise<void> {
  await px().procedure("space.roomy.push.setPreferences", {
    spaceId,
    level,
  });
}