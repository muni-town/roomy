<script lang="ts">
  import type { WithElementRef } from "bits-ui";
  import type { HTMLAttributes } from "svelte/elements";
  import { ScrollArea } from "@fuxui/base";

  const {
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {} = $props();
</script>

<div
  class={"overflow-y-hidden bg-base-100/80 pl-2 block h-full w-64 border-r border-base-800/10 dark:border-base-300/10"}
  {...restProps}
>
  <ScrollArea orientation="vertical" class="h-full overflow-y-scroll">
    {@render children?.()}
  </ScrollArea>
</div>
