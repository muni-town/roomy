<script lang="ts">
  import { sync_, type SyncStatus } from "$lib/sync.svelte";
  import { IconAlertCircle, IconLoading } from "@roomy/design/icons";

  let status = $derived(sync_.ctx?.status ?? { state: "idle" });

  /** Only show the banner for non-transient states that indicate a problem. */
  let visible = $derived(
    status.state === "reconnecting" || status.state === "disconnected",
  );

  let message = $derived.by(() => {
    const s = status as SyncStatus;
    switch (s.state) {
      case "reconnecting":
        if (s.attempt > 5) {
          return `Connection lost — retrying (attempt ${s.attempt}, ~${formatDelay(s.delayMs)})`;
        }
        return `Connection lost — reconnecting…`;
      case "disconnected":
        return "Disconnected from server";
      default:
        return "";
    }
  });

  let isWarning = $derived(
    status.state === "reconnecting" &&
      (status as { attempt: number }).attempt <= 5,
  );

  function formatDelay(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }
</script>

{#if visible}
  <div
    class="flex items-center gap-2 px-4 py-1.5 text-xs font-medium transition-all {isWarning
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
      : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400'}"
    role="status"
    aria-live="polite"
  >
    {#if status.state === "reconnecting"}
      <IconLoading class="w-3.5 h-3.5 animate-spin shrink-0" />
    {:else}
      <IconAlertCircle class="w-3.5 h-3.5 shrink-0" />
    {/if}
    <span>{message}</span>
  </div>
{/if}
