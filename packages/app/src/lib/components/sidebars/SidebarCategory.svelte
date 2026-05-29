<script lang="ts">
  import type { SidebarCategory } from "$lib/queries";
  import { page } from "$app/state";
  import SidebarItem from "./SidebarItem.svelte";
  import SidebarCategoryShell from "@roomy/design/components/sidebars/SidebarCategoryShell.svelte";
  import type { Ulid } from "@roomy-space/sdk";

  let {
    category,
    isEditing = $bindable(false),
    editSidebarItem,
    onRoomMove,
  }: {
    category: SidebarCategory;
    isEditing: boolean;
    editSidebarItem: (
      id: { room: Ulid } | { categoryId: Ulid; categoryName: string },
    ) => void;
    onRoomMove?: (newChildren: SidebarCategory["children"]) => void;
  } = $props();
</script>

<SidebarCategoryShell
  name={category.name}
  items={category.children ?? []}
  {isEditing}
  active={category.id === page.params.object}
  onEditCategory={() =>
    editSidebarItem({
      categoryId: category.id,
      categoryName: category.name,
    })}
  onItemsReorder={(newChildren) => onRoomMove?.(newChildren)}
>
  {#snippet item(room, index)}
    <SidebarItem bind:isEditing {editSidebarItem} {index} item={room} />
  {/snippet}
</SidebarCategoryShell>
