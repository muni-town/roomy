<script lang="ts">
  import { queryHealth } from "$lib/query-health.svelte";
  import { IconAlertCircle } from "@roomy/design/icons";

  /**
   * Visible while the cache is holding a value whose last refresh failed.
   *
   * `queryHealth` recomputes on every cache update, so a successful refetch
   * clears the banner without anything having to remember which query failed.
   */
  let visible = $derived(queryHealth.staleCount > 0);
</script>

{#if visible}
  <div
    class="flex items-center gap-2 px-4 py-1.5 text-xs font-medium transition-all bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
    role="status"
    aria-live="polite"
  >
    <IconAlertCircle class="w-3.5 h-3.5 shrink-0" />
    <span>Showing saved content — the latest couldn't be loaded.</span>
  </div>
{/if}
