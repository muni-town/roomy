<script lang="ts">
  import type { WithElementRef } from "bits-ui";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn, ScrollArea } from "@foxui/core";
  import * as rawEnv from "$env/static/public";

  const {
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {} = $props();
</script>

<div
  class={cn(
    "overflow-y-hidden flex flex-col justify-between h-full w-64",
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

  {#if "PUBLIC_SHOW_BRANDING" in rawEnv && rawEnv.PUBLIC_SHOW_BRANDING === "true"}
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
