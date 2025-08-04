<script lang="ts">
  import { Tooltip } from "bits-ui";
  import type { Snippet } from "svelte";

  type Props = {
    tip: string | Snippet;
    children: Snippet;
  };

  let { tip, children }: Props = $props();
</script>

<Tooltip.Root delayDuration={200}>
  <Tooltip.Trigger>
    {@render children()}
  </Tooltip.Trigger>

  <Tooltip.Content sideOffset={12}>
    <span
      class="rounded-lg border-base-200 dark:border-base-800 shadow-xs bg-base-100/50 dark:bg-base-900/50 text-base-800/75 dark:text-base-200/75 outline-hidden z-0 flex items-center justify-center border p-1 px-2 text-sm"
    >
      {#if typeof tip === "string"}
        {tip}
      {:else}
        {@render tip()}
      {/if}
    </span>
  </Tooltip.Content>
</Tooltip.Root>
