<script lang="ts">
  import type { WithElementRef } from "bits-ui";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "@foxui/core";

  const {
    class: className,
    children,
    hasSidebar = false,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    hasSidebar?: boolean;
  } = $props();
</script>

<div
  class={cn(
    "isolate bg-base-200/50 dark:bg-black z-10 w-18 flex flex-col justify-between overflow-hidden",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
