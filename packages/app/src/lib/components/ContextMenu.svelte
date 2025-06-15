<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    ContextMenu,
    type ContextMenuRootProps,
    type WithoutChild,
  } from "bits-ui";
  import Icon from "@iconify/svelte";
  type Props = ContextMenuRootProps & {
    menuTitle?: string;
    children: Snippet;
    items: { label: string; icon?: string; onselect?: () => void; destructive?: boolean }[];
    contentProps?: WithoutChild<ContextMenu.ContentProps>;
    // other component props if needed
  };
  let {
    open = $bindable(false),
    children,
    items,
    menuTitle,
    contentProps,
    ...restProps
  }: Props = $props();
</script>

<ContextMenu.Root bind:open {...restProps}>
  <ContextMenu.Trigger>
    {@render children()}
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content {...contentProps} class="z-[60] bg-base-100 border border-base-300 rounded-lg shadow-lg min-w-48 p-1">
      <ContextMenu.Group>
        {#if menuTitle}
          <ContextMenu.GroupHeading class="px-3 py-2 text-xs font-semibold text-base-content/60 uppercase tracking-wide">
            {menuTitle}
          </ContextMenu.GroupHeading>
        {/if}
        {#each items as item}
          <ContextMenu.Item 
            textValue={item.label} 
            onclick={item.onselect}
            class="flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-base-200 cursor-pointer transition-colors {item.destructive ? 'text-error hover:bg-error/10' : ''}"
          >
            {#if item.icon}
              <Icon icon={item.icon} class="size-4" />
            {/if}
            {item.label}
          </ContextMenu.Item>
        {/each}
      </ContextMenu.Group>
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
