/**
 * Imperative mount helper for the scope-consent dialogue.
 *
 * `guardedXrpc` and the plan's strategy-B flow need a `prompt(tier) =>
 * Promise<boolean>` seam — a function that shows the dialogue and resolves
 * with the user's accept/reject decision. A bare function can't render a
 * Svelte 5 component, so this mounts `ScopeConsentDialogue` imperatively into
 * `document.body` (the same `mount`/`unmount` pattern as
 * `enrich-internal-links.ts`), then resolves with the decision and tears the
 * node down.
 *
 * App-password (test) mode: `requestScopeExpansion` is a no-op, so an accept
 * resolves without navigating; the caller's guard (`guardedXrpc`) never
 * retries, so there is no loop.
 */
import { mount, unmount } from "svelte";
import ScopeConsentDialogue from "$lib/components/ScopeConsentDialogue.svelte";
import type { ScopeSetName } from "$lib/scopes";

export interface ScopeConsentOptions {
  /** Short capability name, e.g. "Create Space cards". */
  title: string;
  /** The consequence of granting, e.g. "…so Roomy can create cards." */
  description: string;
}

/** Show the consent dialogue for `tier` and resolve with the user's decision. */
export function showScopeConsentDialogue(
  tier: ScopeSetName,
  opts: ScopeConsentOptions,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  const host = document.createElement("div");
  document.body.appendChild(host);

  const settle = (accepted: boolean): void => {
    if (settled) return;
    settled = true;
    unmount(badge);
    host.remove();
    resolve(accepted);
  };

  const badge = mount(ScopeConsentDialogue, {
    target: host,
    props: {
      tier,
      title: opts.title,
      description: opts.description,
      onAccept: () => settle(true),
      onReject: () => settle(false),
    },
  });
  return promise;
}
