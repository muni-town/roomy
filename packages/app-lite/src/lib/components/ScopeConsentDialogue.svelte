<script lang="ts">
  /**
   * ScopeConsentDialogue — friendly accept/reject prompt for a scope expansion.
   *
   * Naming the *capability* and its *consequence* ("Roomy needs permission to
   * create cards in your Space" — not the OAuth scope token). Accept drives the
   * OAuth consent round-trip via `requestScopeExpansion(tier)`; reject fails
   * the pending action cleanly and leaves the UI usable.
   *
   * Drive it imperatively via `showScopeConsentDialogue(...)` from
   * `$lib/scope-consent-dialogue.ts` (the `prompt` seam `guardedXrpc` and
   * `ScopeGate` consume); mounting it inline is not intended.
   *
   * In app-password (test) mode `requestScopeExpansion` is a no-op, so the
   * accept button calls it (safe, no-op) then resolves `true`; the caller's
   * guard does not retry, so there is no loop.
   */
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { requestScopeExpansion } from "$lib/auth.svelte";
  import type { ScopeSetName } from "$lib/scopes";

  let {
    tier,
    title,
    description,
    onAccept,
    onReject,
  }: {
    tier: ScopeSetName;
    /** Short capability name, e.g. "Create Space cards". */
    title: string;
    /** The consequence of granting, e.g. "…so Roomy can create cards." */
    description: string;
    onAccept: () => void;
    onReject: () => void;
  } = $props();

  let busy = $state(false);

  async function accept(): Promise<void> {
    busy = true;
    await requestScopeExpansion(tier);
    onAccept();
  }
  function reject(): void {
    onReject();
  }
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-base-50/90 dark:bg-base-950/90 backdrop-blur-sm"
  role="dialog"
  aria-modal="true"
  aria-labelledby="scope-consent-title"
>
  <div
    class="m-4 max-w-md w-full p-6 rounded-2xl bg-base-50 dark:bg-base-950 border border-base-200 dark:border-base-800 shadow-lg flex flex-col gap-4"
  >
    <h3 id="scope-consent-title" class="text-lg font-semibold text-base-900 dark:text-base-50">
      {title}
    </h3>
    <p class="text-sm text-base-600 dark:text-base-300">{description}</p>
    <div class="flex justify-end gap-3">
      <Button variant="ghost" onclick={reject} disabled={busy}>Not now</Button>
      <Button variant="primary" onclick={accept} disabled={busy}>
        {busy ? "Redirecting…" : "Grant permission"}
      </Button>
    </div>
  </div>
</div>
