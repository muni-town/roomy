<script lang="ts">
  import type { WithElementRef } from "bits-ui";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn, ScrollArea } from "@fuxui/base";

  const {
    class: className,
    mobileClasses,
    children,
    mobileOnly = false,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    mobileClasses?: string;
    mobileOnly?: boolean;
  } = $props();

  const borderClasses =
    "border-x shadow-lg shadow-base-800/20 border-base-800/20 dark:border-base-300/10 backdrop-blur-xl";
</script>

  <div
    class={cn(
      borderClasses,
      "fixed ml-0.5 overflow-y-hidden",
      "inset-auto left-20 top-0 bottom-0 z-50 block h-[100dvh] w-64",
      className,
    )}
    {...restProps}
  >
    <div class={cn("bg-base-100 h-full overflow-y-hidden pl-2")}>
      <ScrollArea orientation="vertical" class="h-full overflow-y-scroll">
        {@render children?.()}
      </ScrollArea>
    </div>
  </div>
