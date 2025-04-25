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
    items: { label: string; icon?: string; onselect?: () => void }[];
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
    <ContextMenu.Content {...contentProps}>
      <ContextMenu.Group class="dz-menu bg-base-200 rounded-box w-56">
        {#if menuTitle}
          <li class="dz-menu-title">
            <ContextMenu.GroupHeading>{menuTitle}</ContextMenu.GroupHeading>
          </li>
        {/if}
        <li>
          {#each items as item}
            <!-- TODO: for some reason onselect event doesn't work so we use onclick which is not good
            for keyboard control. -->
            <ContextMenu.Item textValue={item.label} onclick={item.onselect}>
              {#if item.icon}
                <Icon icon={item.icon} font-size="1.5em" />
              {/if}
              {item.label}
            </ContextMenu.Item>
          {/each}
        </li>
      </ContextMenu.Group>
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
