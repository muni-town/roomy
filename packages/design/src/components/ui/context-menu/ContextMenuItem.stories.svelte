<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { type ComponentProps } from "svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import ContextMenuItem from "./ContextMenuItem.svelte";
  import ContextMenuSeparator from "./ContextMenuSeparator.svelte";

  const { Story } = defineMeta({
    title: "UI/ContextMenuItem",
    component: ContextMenuItem,
    render: template,
  });

  function noop() {}
</script>

{#snippet template(args: ComponentProps<typeof ContextMenuItem>)}
  <div class="p-24">
    <ContextMenu side="bottom">
      {#snippet trigger({ props })}
        <button {...props} class="rounded-md border border-base-300 px-3 py-1">
          Open menu
        </button>
      {/snippet}
      {#snippet children()}
        <ContextMenuItem onSelect={noop}>New channel</ContextMenuItem>
        <ContextMenuItem onSelect={noop}>Rename</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={noop} {...args}>
          Delete
        </ContextMenuItem>
      {/snippet}
    </ContextMenu>
  </div>
{/snippet}

<Story name="Default" args={{ variant: "default" }} {template} />
<Story name="Danger" args={{ variant: "danger" }} {template} />
