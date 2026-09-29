<script lang="ts">
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import { toast } from "@foxui/core";
  import { auth, requestScopeExpansion, revokeScopeSettings } from "$lib/auth.svelte";
  import { createScopeSettingsQuery } from "$lib/queries/scope-settings";
  import { hasScopeSet, type ScopeSetName } from "$lib/scopes";
  import { queryClient } from "$lib/client";

  const settingsQuery = createScopeSettingsQuery();
  const queryKey = ["space.roomy.auth.getScopeSettings"];

  // The granted scope is what the live token actually holds. The server's
  // stored `scope`/`requestedScope` drive display of the raw strings.
  const grantedScope = $derived(auth.grantedScope);

  let busy = $state<ScopeSetName | null>(null);

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey });
  }

  /** Toggle an extra capability tier. */
  async function toggle(tier: ScopeSetName, enabled: boolean): Promise<void> {
    busy = tier;
    try {
      if (enabled) {
        await requestScopeExpansion(tier);
        return; // browser navigates to the PDS consent screen
      }
      await revokeScopeSettings(); // narrows stored grant; live token unchanged
      await refresh();
      toast.success(
        "Removed. This takes effect at your next login — the current " +
          "session keeps its access until you sign in again.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy = null;
    }
  }
</script>

<div class="flex flex-col gap-10">
  <section>
    <h2 class="text-base font-semibold mb-1 text-base-900 dark:text-base-100">
      Data access
    </h2>
    <p class="text-sm text-base-400 mb-4">
      Roomy requests permission to read or write data on your personal
      account. You control which capabilities are enabled. Enabling a
      capability on your account starts a quick sign-in to confirm with your
      provider; removing one applies on your next sign-in.
    </p>
  </section>

  {#if settingsQuery.isPending}
    <p class="text-sm text-base-400">Loading access settings…</p>
  {:else if settingsQuery.isError}
    <ErrorMessage message="Error: {settingsQuery.error.message}" class="py-4" />
  {:else if settingsQuery.data}
    {#snippet capabilityRow(name: string, desc: string, tier: ScopeSetName)}
      {@const granted = grantedScope !== null && hasScopeSet(grantedScope, tier)}
      <div class="flex items-start justify-between gap-4 py-4 border-t border-base-200 dark:border-base-800">
        <div class="min-w-0">
          <p class="text-sm font-medium text-base-900 dark:text-base-100">{name}</p>
          <p class="text-sm text-base-400 mt-0.5">{desc}</p>
        </div>
        <Button
          size="sm"
          variant={granted ? "secondary" : "primary"}
          onclick={() => toggle(tier, !granted)}
          disabled={busy !== null && busy !== tier}
        >
          {busy === tier
            ? "Working…"
            : granted
              ? "Remove"
              : "Enable"}
        </Button>
      </div>
    {/snippet}

    {@render capabilityRow(
      "Profile",
      "Read your public profile to show who you are across Roomy spaces.",
      "base",
    )}

    {@render capabilityRow(
      "Semble collections",
      "Save cards to your own Semble collection. Requests write access to " +
        "your personal `network.cosmik.card` records.",
      "semble",
    )}

    {@render capabilityRow(
      "Direct messages",
      "Send and receive direct messages. (Not yet used by any Roomy " +
        "feature.)",
      "withDms",
    )}

    {#if settingsQuery.data.scope}
      <div class="pt-4 border-t border-base-200 dark:border-base-800">
        <p class="text-xs text-base-400">
          Your current stored grant:
        </p>
        <code
          class="block text-[11px] text-base-500 dark:text-base-400 break-all mt-1 bg-base-100 dark:bg-base-900 rounded-md px-2 py-1.5">{settingsQuery.data.scope}</code>
        {#if settingsQuery.data.requestedScope}
          <p class="text-xs text-base-400 mt-2">
            Pending request (confirm at your next sign-in):
          </p>
          <code
            class="block text-[11px] text-base-500 dark:text-base-400 break-all mt-1 bg-base-100 dark:bg-base-900 rounded-md px-2 py-1.5">{settingsQuery.data.requestedScope}</code>
        {/if}
      </div>
    {/if}
  {/if}
</div>
