<script lang="ts">
  import type { WithElementRef } from "bits-ui";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "../../utils/index.js";

  const {
    class: className,
    children,
    hasSidebar = false,
    compact = false,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    hasSidebar?: boolean;
    compact?: boolean;
  } = $props();
</script>

<div
  class={cn(
    "w-full flex items-center justify-between px-1.5 py-1 shrink-0 border-b border-base-300/10",
    compact ? "h-11" : "h-16",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
