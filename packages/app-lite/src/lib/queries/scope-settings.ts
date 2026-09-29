import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

/**
 * Query for the authenticated user's OAuth scope settings.
 *
 * Returns the raw stored (last-granted) scope string plus any pending
 * expansion intent. Tier coverage ("does my grant cover `semble`?") is
 * derived client-side from the raw scope via `hasScopeSet` — the server does
 * not know tier names (scope-expansion plan Open Question 1).
 */
export function createScopeSettingsQuery(enabled: () => boolean = () => true) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.auth.getScopeSettings"),
    queryFn: () => px().query("space.roomy.auth.getScopeSettings", {}),
    // Gated behind the access-settings feature flag: the page is unreachable
    // while the flag is off, so do not issue the request then. All flags
    // default false.
    enabled: enabled(),
  }));
}

export type ScopeSettings =
  typeof schemas.queries.getScopeSettings.Response.infer;
