<script lang="ts">
  import type { WithElementRef } from "bits-ui";
  import type { HTMLAttributes } from "svelte/elements";
  import { Button, cn } from "@fuxui/base";

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
    "w-full flex h-16 items-center justify-between p-2 overflow-hidden flex-shrink-0 bg-base-100 dark:bg-base-950 border-b border-base-800/10 dark:border-base-300/10",
    className,
  )}
  {...restProps}
>
  {@render children?.()}

  <Button href="https://a.roomy.space" target="_blank">About Roomy</Button>
</div>
