<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ContextMenu from "./ContextMenu.svelte";
  import ContextMenuItem from "./ContextMenuItem.svelte";
  import ContextMenuSeparator from "./ContextMenuSeparator.svelte";

  const { Story } = defineMeta({
    title: "UI/ContextMenuSeparator",
    component: ContextMenuSeparator,
  });

  function noop() {}
</script>

{#snippet template()}
  <div class="p-4">
    <p class="mb-6 text-sm text-base-400">
      A thin divider used to group items inside a <code>ContextMenu</code>. It takes
      no props; here it is shown between menu items so it is visible.
    </p>
    <ContextMenu side="bottom">
      {#snippet trigger({ props })}
        <button {...props} class="rounded-md border border-base-300 px-3 py-1">
          Open menu
        </button>
      {/snippet}
      {#snippet children()}
        <ContextMenuItem onSelect={noop}>Copy link</ContextMenuItem>
        <ContextMenuItem onSelect={noop}>Share</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={noop} variant="danger">
          Delete
        </ContextMenuItem>
      {/snippet}
    </ContextMenu>
  </div>
{/snippet}

<Story name="Default" {template} />
