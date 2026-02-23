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
    "w-full flex h-16 items-center justify-between p-2 shrink-0",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
