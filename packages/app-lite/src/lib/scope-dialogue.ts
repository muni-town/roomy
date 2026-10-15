/**
 * Imperative mount helper for the scope dialogues.
 *
 * `guardedXrpc` and the settings page need a `prompt(tier) => Promise<boolean>`
 * seam — a function that shows the dialogue and resolves with the user's
 * answer. A bare function cannot render a Svelte 5 component, so this mounts one
 * into `document.body` (the same `mount`/`unmount` pattern as
 * `enrich-internal-links.ts`), then resolves and tears the node down.
 *
 * Which dialogue is not the caller's decision. A requestable tier gets the
 * consent dialogue, whose accept drives the OAuth round-trip and resolves
 * `true`. A ceiling-only tier (`isRequestableScopeSet` false) gets the notice
 * saying Roomy cannot request the permission yet, and resolves `false`: there is
 * no consent to give, and driving a round-trip could not change the session.
 *
 * App-password (test) mode: `requestScopeExpansion` is a no-op, so an accept
 * resolves without navigating; the caller's guard (`guardedXrpc`) never
 * retries, so there is no loop.
 */
import { mount, unmount } from "svelte";
import ScopeConsentDialogue from "$lib/components/ScopeConsentDialogue.svelte";
import ScopeUnavailableDialogue from "$lib/components/ScopeUnavailableDialogue.svelte";
import { isRequestableScopeSet, type ScopeSetName } from "$lib/scopes";

export interface ScopeDialogueCopy {
  /** Short capability name, e.g. "Create Space cards". */
  title: string;
  /** The consequence of the permission, e.g. "…so Roomy can create cards." */
  description: string;
}

/** Show the dialogue `tier` calls for and resolve with the user's answer. */
export function showScopeDialogue(
  tier: ScopeSetName,
  copy: ScopeDialogueCopy,
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

  const badge = isRequestableScopeSet(tier)
    ? mount(ScopeConsentDialogue, {
        target: host,
        props: {
          tier,
          title: copy.title,
          description: copy.description,
          onAccept: () => settle(true),
          onReject: () => settle(false),
        },
      })
    : mount(ScopeUnavailableDialogue, {
        target: host,
        props: {
          title: copy.title,
          description: copy.description,
          onDismiss: () => settle(false),
        },
      });
  return promise;
}
