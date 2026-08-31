<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SidebarCategoryShell from "./SidebarCategoryShell.svelte";
  import SidebarItemShell from "./SidebarItemShell.svelte";

  const { Story } = defineMeta({
    title: "Sidebars/SidebarCategoryShell",
    component: SidebarCategoryShell,
  });

  type Args = {
    name: string;
    items: { id: string; name: string }[];
    isEditing: boolean;
  };
</script>

{#snippet template(args: Args)}
  <div class="p-4 w-64">
    <SidebarCategoryShell
      {...(args as any)}
      onEditCategory={() => {
        /* no-op in story */
      }}
      onItemsReorder={() => {
        /* no-op in story */
      }}
    >
      {#snippet item(item: { id: string; name: string }, _index: number)}
        <SidebarItemShell
          variant="channel"
          name={item.name}
          href={`#/${item.id}`}
          active={false}
          plain={args.isEditing}
          onclick={() => {
            /* no-op in story */
          }}
        />
      {/snippet}
    </SidebarCategoryShell>
  </div>
{/snippet}

<Story
  name="Editing"
  args={{
    name: "Channels",
    items: [
      { id: "c1", name: "General" },
      { id: "c2", name: "Random" },
    ],
    isEditing: true,
  }}
  {template}
/>

<Story
  name="Default"
  args={{
    name: "Channels",
    items: [
      { id: "c1", name: "General" },
      { id: "c2", name: "Random" },
    ],
    isEditing: false,
  }}
  {template}
/>
