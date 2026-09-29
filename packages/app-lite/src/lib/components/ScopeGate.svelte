<!--
  ScopeGate — reusable "does the current session have this tier?" gate.

  Renders its default slot only when the current session's granted OAuth scope
  covers every token in the named `tier` (see `auth.hasScope` and
  `scopes.SCOPE_SETS`). When the tier is not granted, renders the `denied`
  slot, or — if none is provided — a "Grant permission" panel that drives the
  OAuth consent round-trip via `requestScopeExpansion(tier)`.

  Wired to `requestScopeExpansion` in Phase 5 so a feature needing a scope the
  session lacks prompts the user instead of surfacing an unfriendly raw error.

  Note: in app-password (test-mode) sessions the granted scope is the full
  requested tier, so `hasScope` reports true for it here too — E2E runs behave
  like a fully-consented OAuth session, and `requestScopeExpansion` is a no-op
  there (no crash, no loop).
-->
<script lang="ts">
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { auth, requestScopeExpansion } from "$lib/auth.svelte";
  import type { ScopeSetName } from "$lib/scopes";

  let {
    tier,
    title,
    description,
    children,
    denied = undefined,
  }: {
    /** The tier the gated content requires (e.g. "base"; later "semble"). */
    tier: ScopeSetName;
    /** Shown in the default "Grant permission" panel when the tier is missing. */
    title: string;
    /** The consequence of granting, shown under the title. */
    description: string;
    /** Rendered when the session grants the tier. */
    children?: import("svelte").Snippet;
    /** Rendered instead of `children` when the tier is not granted. Overrides
     *  the default "Grant permission" panel entirely. */
    denied?: import("svelte").Snippet;
  } = $props();

  const granted = $derived(auth.hasScope(tier));

  let expanding = $state(false);

  async function expand(): Promise<void> {
    expanding = true;
    await requestScopeExpansion(tier); // navigates away in OAuth; no-op in test
    expanding = false;
  }
</script>

{#if granted}
  {@render children?.()}
{:else if denied}
  {@render denied()}
{:else}
  <div
    class="flex flex-col gap-2 rounded-xl border border-base-200 dark:border-base-800 p-4"
  >
    <p class="text-sm font-semibold text-base-900 dark:text-base-50">{title}</p>
    <p class="text-sm text-base-600 dark:text-base-300">{description}</p>
    <div class="mt-1">
      <Button variant="primary" onclick={expand} disabled={expanding}>
        {expanding ? "Redirecting…" : "Grant permission"}
      </Button>
    </div>
  </div>
{/if}
