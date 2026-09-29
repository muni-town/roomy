<!--
  ScopeGate — reusable "does the current session have this tier?" gate.

  Renders its default slot only when the current session's granted OAuth scope
  covers every token in the named `tier` (see `auth.hasScope` and
  `scopes.SCOPE_SETS`). When the tier is not granted, renders the `denied`
  slot (or nothing if none is provided).

  Unused as of Phase 3 — landed ahead of Phase 5, where the reactive consent
  dialogue drives it. Phase 5 wires this gate to `requestScopeExpansion(tier)`
  so a feature needing a scope the session lacks prompts the user instead of
  surfacing an unfriendly scope error.

  Note: in app-password (test-mode) sessions the granted scope is the full
  requested tier, so `hasScope` reports true for it here too — E2E runs behave
  like a fully-consented OAuth session.
-->
<script lang="ts">
  import { auth } from "$lib/auth.svelte";
  import type { ScopeSetName } from "$lib/scopes";

  let {
    tier,
    children,
    denied = undefined,
  }: {
    /** The tier the gated content requires (e.g. "base"; later "semble"). */
    tier: ScopeSetName;
    /** Rendered when the session grants the tier. */
    children?: import("svelte").Snippet;
    /** Rendered instead of `children` when the tier is not granted. */
    denied?: import("svelte").Snippet;
  } = $props();

  const granted = $derived(auth.hasScope(tier));
</script>

{#if granted}
  {@render children?.()}
{:else if denied}
  {@render denied()}
{/if}
