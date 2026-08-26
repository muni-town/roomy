import { ArbiterClient } from "@roomy-space/sdk";
import { auth } from "$lib/auth.svelte";

/**
 * Build an authenticated arbiter client for acting under the current user's
 * authority as a space admin.
 *
 * The arbiter (leaf-0.4) proxies operations to a space's stewarded account.
 * The arbiter server itself is discovered per space from its
 * `town.muni.arbiter.service` record (see `ArbiterClient#resolveArbiter`), so
 * only the caller's authenticated Agent is needed here — no global config.
 *
 * Throws if there is no authenticated session.
 */
export function createArbiterClient(): ArbiterClient {
  const agent = auth.agent;
  if (!agent) throw new Error("Not authenticated");
  return new ArbiterClient(agent);
}
