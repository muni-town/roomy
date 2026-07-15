import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

/**
 * Query for feature flags enabled for the current user.
 * Returns a set of flag keys that are active for this user.
 * All flags default to false.
 */
export function createFeatureFlagsQuery() {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.getFlags"),
    queryFn: () => px().query("space.roomy.getFlags", {}),
  }));
}
