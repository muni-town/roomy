<script lang="ts">
  /***
   * Temporarily copied from Fox UI ScrollArea component by Flo-bit
   * https://github.com/flo-bit/ui-kit/blob/main/packages/core/src/lib/components/scroll-area/ScrollArea.svelte
   */

  import { type WithElementRef } from "bits-ui";
  import { cn } from "../../utils/index.js";
  import type { HTMLAttributes } from "svelte/elements";

  type Props = WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    orientation?: "vertical" | "horizontal" | "both";
  };

  let {
    ref = $bindable(null),
    orientation = "vertical",
    class: className,
    children,
    ...restProps
  }: Props = $props();

  function getOrientationClasses() {
    if (orientation === "vertical") return "overflow-y-scroll";
    if (orientation === "horizontal") return "overflow-x-scroll";
    return "overflow-y-scroll overflow-x-scroll";
  }
</script>

<div
  bind:this={ref}
  class={cn("scrollbar", getOrientationClasses(), className)}
  {...restProps}
>
  {@render children?.()}
</div>

<!-- Scrollbar styling comes from the shared `.scrollbar` class (src/scrollbar.css). -->
