<script lang="ts">
  import type { WithElementRef } from "bits-ui";
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { cn } from "../../utils/index.js";
  import { ScrollArea } from "@foxui/core";

  let {
    class: className,
    children,
    footer,
    showBranding = false,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    /** Content rendered below the scroll area, pinned to the bottom (e.g. user card) */
    footer?: Snippet;
    /** Whether to show the "powered by roomy" branding footer */
    showBranding?: boolean;
  } = $props();
</script>

<div
  class={cn(
    "overflow-y-hidden flex flex-col justify-between h-full w-64 dark:border-r dark:border-base-300/10",
    className,
  )}
  {...restProps}
>
  <ScrollArea
    orientation="vertical"
    class="h-full overflow-y-auto flex flex-col"
  >
    {@render children?.()}
  </ScrollArea>

  {#if footer}
    {@render footer()}
  {/if}

  {#if showBranding}
    <div class="text-xs p-2">
      <span class="text-base-500 dark:text-base-300">powered by</span>
      <a
        target="_blank"
        href="https://roomy.space"
        class="text-accent-700 dark:text-accent-400 hover:text-accent-600 dark:hover:text-accent-500"
        >roomy.space</a
      >
    </div>
  {/if}
</div>