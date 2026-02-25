<script lang="ts">
  import { page } from "$app/state";
  import { flags } from "$lib/config";
  import { getAppState } from "$lib/queries";

  const app = getAppState();
  import SpaceSidebarHeader from "./SpaceSidebarHeader.svelte";
  import EditRoomModal from "../modals/EditRoomModal.svelte";
  import Button from "$lib/components/ui/button/Button.svelte";

  import {
    IconCheck,
    IconHome,
    IconHashtag,
    IconGripVertical,
  } from "@roomy/design/icons";
  import SidebarCategory from "./SidebarCategory.svelte";
  import { type SidebarCategory as SidebarCategoryType } from "$lib/queries";
  import EntityName from "../primitives/EntityName.svelte";
  import { newUlid, Ulid } from "@roomy/sdk";

  import {
    dragHandleZone,
    dragHandle,
    SHADOW_ITEM_MARKER_PROPERTY_NAME,
  } from "svelte-dnd-action";
  import { peer } from "$lib/workers";
  // at the top level there can be categories, channels or pages
  // under categories there can be channels or pages
  // under channels there can be threads or pages

  let isEditing = $state(false);
  let editingId = $state<
    { room: Ulid } | { categoryId: Ulid; categoryName: string } | null
  >(null);

  function editSidebarItem(
    id: { room: Ulid } | { categoryId: Ulid; categoryName: string },
  ) {
    console.debug("Edit sidebar item");
    openEditRoomModal = true;
    editingId = id;
  }

  const roomsInSidebar = $derived(
    new Set([
      ...(app.categories?.flatMap((cat) =>
        cat.children.map((child) => child.id),
      ) || []),
    ]),
  );

  const parentContext = $derived(page.url.searchParams.get("parent"));

  let openEditRoomModal = $state(false);

  function renameCategory(id: Ulid, newName: string) {
    // keep the 'id' (old name) the same in the categoryMap
    // but change the name in state
    console.debug("Rename category", { id, newName });
    const category = categoryMap.get(id);
    const renamed = {
      ...category,
      name: newName,
    } as SidebarCategoryType;
    categoryMap.set(id, renamed);
    categoryMap = new Map(categoryMap);
    // draftOrder = draftOrder;
    console.debug("new categoryMap", $state.snapshot(categoryMap));
  }

  async function saveChanges() {
    if (draftOrder && app.joinedSpace) {
      // TODO: persist draftCategories to peer
      // Generate ULIDs for v0 categories that used name as id
      const newSidebar = draftOrder.map((c) => ({
        id: Ulid.allows(c.id) ? c.id : newUlid(),
        name: categoryMap.get(c.id)?.name ?? "",
        children: c.childIds as Ulid[],
      }));
      console.log("newSidebar", $state.snapshot(newSidebar));
      await peer.sendEvent(app.joinedSpace.id, {
        id: newUlid(),
        $type: "space.roomy.space.updateSidebar.v1",
        categories: $state.snapshot(newSidebar),
      });
    }
    draftOrder = null;
    isEditing = false;
  }

  let categories = $derived(app.categories ?? []);

  type DraftOrder = {
    id: Ulid;
    childIds: Ulid[];
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: boolean;
  }[];

  let draftOrder = $state<DraftOrder | null>(null);

  // Build lookup maps from the latest sidebar data
  let categoryMap = $derived(
    new Map(app.categories?.map((c) => [c.id, c]) ?? []),
  );
  const roomMap = $derived(
    new Map(
      app.categories?.flatMap((c) => c.children.map((r) => [r.id, r])) ?? [],
    ),
  );

  // Derive display by merging draft order with latest names
  const displayCategories: (SidebarCategoryType & {
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: boolean;
  })[] = $derived.by(() => {
    console.debug("evaluating displayCategories");
    if (!draftOrder) return categories;

    return draftOrder
      .map((draft) => {
        const latestCat = categoryMap.get(draft.id);
        if (!latestCat) return null;

        return {
          ...latestCat,
          ...(draft[SHADOW_ITEM_MARKER_PROPERTY_NAME] && {
            [SHADOW_ITEM_MARKER_PROPERTY_NAME]: true,
          }),
          children: draft.childIds
            .map((childId) => roomMap.get(childId))
            .filter((r): r is NonNullable<typeof r> => r != null),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c != null);
  });

  // Update the effect that initializes draft state
  $effect(() => {
    if (isEditing && !draftOrder) {
      draftOrder = categories.map((c) => ({
        id: c.id,
        childIds: c.children.map((ch) => ch.id),
      }));
    }
    if (!isEditing && draftOrder) {
      draftOrder = null;
    }
  });

  // Update handlers to work with the new structure
  function handleCategoryReorder(newCategories: SidebarCategoryType[]) {
    draftOrder = newCategories.map((c) => ({
      id: c.id,
      childIds: c.children.map((ch) => ch.id),
    }));
  }

  function handleRoomMove(
    categoryId: string,
    newChildren: SidebarCategoryType["children"],
  ) {
    if (!draftOrder) return;

    draftOrder = draftOrder.map((cat) =>
      cat.id === categoryId
        ? { ...cat, childIds: newChildren.map((ch) => ch.id) }
        : cat,
    );
  }
</script>

<!-- Header -->
<SpaceSidebarHeader bind:isEditing />

{#if app.space.status === "loading"}
  <div class="px-4 mt-2">
    <div class="h-4 bg-base-200 rounded animate-pulse w-3/4 mb-2"></div>
    <div class="h-3 bg-base-200 rounded animate-pulse w-1/2"></div>
  </div>
{:else}
  {#if isEditing}
    <Button class="justify-start mb-4 mx-2 self-stretch" onclick={saveChanges}>
      <IconCheck class="size-4" />
      Finish editing</Button
    >
  {/if}

  <div class="w-full pt-2 px-2">
    {#if flags.threadsList}
      <Button
        class="w-full justify-start mb-2"
        variant="ghost"
        href={`/${page.params.space}/index`}
        data-current={!page.params.object}
      >
        <IconHome class="shrink-0" />
        Index
      </Button>

      <hr class="my-2 border-base-800/10 dark:border-base-100/5" />
    {/if}

    {#if page.params.object && !roomsInSidebar.has(page.params.object as Ulid) && !parentContext}
      <Button
        variant="ghost"
        class="w-full justify-start min-w-0 my-4"
        data-current={true}
      >
        <IconHashtag class="shrink-0" />
        <span
          class={[
            "truncate whitespace-nowrap overflow-hidden min-w-0 font-semibold",
          ]}
        >
          <EntityName id={Ulid.assert(page.params.object)} /></span
        >
      </Button>
    {/if}

    {#if isEditing}
      <div
        class="flex flex-col w-full min-h-4"
        use:dragHandleZone={{
          items: displayCategories,
          type: "category",
          dropTargetClasses: ["min-h-10", "bg-accent-500/10", "rounded"],
          dropTargetStyle: {
            outline: "2px solid var(--color-accent-500/30)",
          },
        }}
        onconsider={(e) => {
          draftOrder = e.detail.items.map((c) => ({
            id: c.id,
            childIds: c.children.map((ch) => ch.id),
            [SHADOW_ITEM_MARKER_PROPERTY_NAME]:
              c[SHADOW_ITEM_MARKER_PROPERTY_NAME],
          }));
        }}
        onfinalize={(e) => handleCategoryReorder(e.detail.items)}
      >
        {#each displayCategories as category ((category as any)[SHADOW_ITEM_MARKER_PROPERTY_NAME] ? `shadow-${category.id}` : category.id)}
          <div class="flex items-start w-full" id={category.id}>
            <div
              use:dragHandle
              aria-label="drag-handle for {category?.name}"
              class="ml-2 mt-2.5 z-10"
            >
              <IconGripVertical class="size-3" />
            </div>
            <SidebarCategory
              bind:isEditing
              {editSidebarItem}
              {category}
              onRoomMove={(newChildren) =>
                handleRoomMove(category.id, newChildren)}
            />
          </div>
        {/each}
      </div>
    {:else}
      <div class="flex flex-col w-full min-h-4">
        {#each app.categories as category (category.id)}
          <div class="flex items-start w-full" id={category.id}>
            <SidebarCategory bind:isEditing {editSidebarItem} {category} />
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<EditRoomModal bind:open={openEditRoomModal} id={editingId} {renameCategory} />
