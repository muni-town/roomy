<script lang="ts" module>
  import { DropdownMenu } from "bits-ui";

  export type ContextMenuItemProps = DropdownMenu.ItemProps & {
    variant?: "default" | "danger";
    inset?: boolean;
  };
</script>

<script lang="ts">
  import { cn } from "../../../utils/index.js";

  let {
    ref = $bindable(null),
    class: className,
    variant = "default",
    inset = false,
    children,
    ...restProps
  }: ContextMenuItemProps = $props();
</script>

<DropdownMenu.Item
  bind:ref
  class={cn(
    "relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none",
    "transition-colors duration-75 border border-transparent",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    variant === "default" &&
      "text-base-800 dark:text-base-200 focus:bg-base-200/70 focus:border-base-200 dark:focus:bg-base-800/70 dark:focus:border-base-800 data-[highlighted]:bg-base-200/70 dark:data-[highlighted]:bg-base-800/70",
    variant === "danger" &&
      "text-red-600 dark:text-red-400 focus:bg-red-100/70 focus:border-red-100 dark:focus:bg-red-900/30 dark:focus:border-red-900/40 data-[highlighted]:bg-red-100/70 dark:data-[highlighted]:bg-red-900/30",
    inset && "pl-8",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</DropdownMenu.Item>
