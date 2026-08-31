<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ContextMenu from "./ContextMenu.svelte";
  import ContextMenuItem from "./ContextMenuItem.svelte";
  import ContextMenuSeparator from "./ContextMenuSeparator.svelte";

  const { Story } = defineMeta({
    title: "UI/ContextMenu",
    component: ContextMenu,
  });

  function noop() {}

  type Args = { side: "bottom" | "right" };
</script>

{#snippet template(args: Args)}
  <div class="p-24">
    <ContextMenu side={args.side}>
      {#snippet trigger({ props })}
        <button {...props} class="rounded-md border border-base-300 px-3 py-1">
          Open menu
        </button>
      {/snippet}
      {#snippet children()}
        <ContextMenuItem onSelect={noop}>New channel</ContextMenuItem>
        <ContextMenuItem onSelect={noop}>Rename</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={noop} variant="danger">
          Delete
        </ContextMenuItem>
      {/snippet}
    </ContextMenu>
  </div>
{/snippet}

<Story name="Bottom" args={{ side: "bottom" }} {template} />
<Story name="Right" args={{ side: "right" }} {template} />
