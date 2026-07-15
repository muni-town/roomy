import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

/**
 * Query for the logged-in user's notification preferences: a user-wide
 * `default` level plus any per-space overrides. Levels: silent | quiet |
 * engaged | busy. Used by the per-space notification settings UI.
 */
export function createPushPreferencesQuery() {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.push.getPreferences"),
    queryFn: () => px().query("space.roomy.push.getPreferences", {}),
  }));
}