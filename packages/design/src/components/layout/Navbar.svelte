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
    "w-full flex items-center justify-between p-2 shrink-0",
    compact ? "h-10" : "h-16",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
