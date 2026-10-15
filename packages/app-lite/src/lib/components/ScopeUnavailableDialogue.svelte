<script lang="ts">
  /**
   * ScopeUnavailableDialogue — the notice for a scope-miss that consenting
   * cannot fix.
   *
   * A tier is ceiling-only when its scopes are declared in Roomy's OAuth
   * metadata but not registered on the deployed API client, which rejects the
   * whole granted set at session registration (see `scopes.ts`
   * UNREGISTERED_SCOPES). No authorization round-trip can carry such a
   * permission, so the consent dialogue's "Grant permission" would lead through
   * the PDS and back to a failed sign-in. This notice takes its place: it names
   * the capability, and says plainly that the permission cannot be requested
   * yet, so the user does not retry a sign-in that cannot change anything.
   *
   * Drive it via `showScopeDialogue(...)`, which selects it for a
   * non-requestable tier; mounting it inline is not intended.
   */
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { SCOPE_UNAVAILABLE_EXPLANATION } from "$lib/scope-guard";

  let {
    title,
    description,
    onDismiss,
  }: {
    /** Short capability name, e.g. "Manage your blocks". */
    title: string;
    /** The consequence of the permission, e.g. "…so Roomy can block accounts." */
    description: string;
    onDismiss: () => void;
  } = $props();
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-base-50/90 dark:bg-base-950/90 backdrop-blur-sm"
  role="dialog"
  aria-modal="true"
  aria-labelledby="scope-unavailable-title"
>
  <div
    class="m-4 max-w-md w-full p-6 rounded-2xl bg-base-50 dark:bg-base-950 border border-base-200 dark:border-base-800 shadow-lg flex flex-col gap-4"
  >
    <h3 id="scope-unavailable-title" class="text-lg font-semibold text-base-900 dark:text-base-50">
      {title}
    </h3>
    <p class="text-sm text-base-600 dark:text-base-300">{description}</p>
    <p class="text-sm text-base-600 dark:text-base-300">{SCOPE_UNAVAILABLE_EXPLANATION}</p>
    <div class="flex justify-end gap-3">
      <Button variant="primary" onclick={onDismiss}>Close</Button>
    </div>
  </div>
</div>
