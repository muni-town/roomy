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
    "border shadow-lg border-base-200 dark:border-base-300/10 backdrop-blur-xl";

  const backgroundClasses =
    "bg-gradient-to-b inset-shadow-sm inset-shadow-base-800/5 dark:inset-shadow-base-100/5 from-base-50/50 to-base-200/50 dark:from-base-900/50 dark:to-base-900/30";
</script>

  <div
    class={cn(
      borderClasses,
      "fixed ml-0.5 overflow-y-hidden",
      "inset-auto left-14 top-0 bottom-0 z-40 block h-[100dvh] w-64",
      className,
    )}
    {...restProps}
  >
    <div class={cn(backgroundClasses, "h-full overflow-y-hidden pl-2")}>
      <ScrollArea orientation="vertical" class="h-full overflow-y-scroll">
        {@render children?.()}
      </ScrollArea>
    </div>
  </div>
