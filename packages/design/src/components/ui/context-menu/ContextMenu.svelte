<script lang="ts" module>
  import { DropdownMenu } from "bits-ui";

  export type ContextMenuProps = DropdownMenu.RootProps & {
    side?: DropdownMenu.ContentProps["side"];
    align?: DropdownMenu.ContentProps["align"];
    sideOffset?: number;
    alignOffset?: number;
  };
</script>

<script lang="ts">
  import { cn } from "../../../utils/index.js";

  let {
    open = $bindable(false),
    onOpenChange,
    children,
    trigger: triggerSnippet,
    side = "bottom",
    align = "start",
    sideOffset = 10,
    alignOffset = 0,
    class: className,
    ...restProps
  }: ContextMenuProps & {
    trigger?: Snippet<[{ props: Record<string, unknown> }]>;
  } = $props();
</script>

<DropdownMenu.Root bind:open {onOpenChange} {...restProps}>
  {#if triggerSnippet}
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        {@render triggerSnippet?.({ props })}
      {/snippet}
    </DropdownMenu.Trigger>
  {/if}

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      {side}
      {align}
      {sideOffset}
      {alignOffset}
      class={cn(
        "z-50 min-w-[180px] overflow-hidden rounded-xl border border-base-200 dark:border-base-800",
        "bg-base-50/90 dark:bg-base-900/20 backdrop-blur-xl",
        "shadow-lg",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
        "p-1",
        className,
      )}
    >
      {@render children?.()}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
