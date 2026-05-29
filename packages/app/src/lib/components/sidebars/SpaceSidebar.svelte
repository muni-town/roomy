<script lang="ts">
  import { page } from "$app/state";
  import { flags } from "$lib/config";
  import { getAppState } from "$lib/queries";

  const app = getAppState();
  import SpaceSidebarHeader from "./SpaceSidebarHeader.svelte";
  import EditRoomModal from "../modals/EditRoomModal.svelte";
  import RestoreRoomModal from "../modals/RestoreRoomModal.svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import SidebarLayout from "@roomy/design/components/sidebars/SidebarLayout.svelte";

  import {
    IconCalendar,
    IconCheck,
    IconHome,
    IconHashtag,
    IconGripVertical,
    IconTrash,
  } from "@roomy/design/icons";
  import SidebarCategory from "./SidebarCategory.svelte";
  import { type SidebarCategory as SidebarCategoryType } from "$lib/queries";
  import EntityName from "$lib/components/helper/EntityName.svelte";
  import { newUlid, Ulid } from "@roomy-space/sdk";

  import { untrack } from "svelte";
  import {
    dragHandleZone,
    dragHandle,
    SHADOW_ITEM_MARKER_PROPERTY_NAME,
  } from "svelte-dnd-action";
  import { peer } from "$lib/workers";
  import { calendarLinkQuery } from "$lib/queries/calendar.svelte";

  let isEditing = $state(false);
  let editingId = $state<
    { room: Ulid } | { categoryId: Ulid; categoryName: string } | null
  >(null);

  function editSidebarItem(
    id: { room: Ulid } | { categoryId: Ulid; categoryName: string },
  ) {
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
  let openRestoreRoomModal = $state(false);

  function renameCategory(id: Ulid, newName: string) {
    const category = categoryMap.get(id);
    const renamed = {
      ...category,
      name: newName,
    } as SidebarCategoryType;
    categoryMap.set(id, renamed);
    categoryMap = new Map(categoryMap);
  }

  async function saveChanges() {
    if (draftOrder && app.joinedSpace) {
      const newSidebar = draftOrder.map((c) => ({
        id: Ulid.allows(c.id) ? c.id : newUlid(),
        name: categoryMap.get(c.id)?.name ?? "",
        children: c.childIds as Ulid[],
      }));
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

  let categoryMap = $derived(
    new Map(app.categories?.map((c) => [c.id, c]) ?? []),
  );
  const roomMap = $derived(
    new Map(
      app.categories?.flatMap((c) => c.children.map((r) => [r.id, r])) ?? [],
    ),
  );

  const displayCategories: (SidebarCategoryType & {
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: boolean;
  })[] = $derived.by(() => {
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

  let spaceId = $derived(app.joinedSpace?.id);
  let calendarLink = $derived(
    flags.calendar && spaceId && calendarLinkQuery(spaceId),
  );
  let hasCalendar = $derived(
    (calendarLink && calendarLink.result && calendarLink.result.length) ||
      0 > 0,
  );

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

  $effect(() => {
    if (!app.categories) return;
    const currentDraft = untrack(() => draftOrder);
    if (!currentDraft) return;

    const draftRoomIds = new Set(currentDraft.flatMap((c) => c.childIds));
    const newRooms = app.categories
      .flatMap((c) => c.children)
      .filter((r) => !draftRoomIds.has(r.id));

    if (newRooms.length === 0) return;

    draftOrder = currentDraft.map((cat, i) =>
      i === 0
        ? { ...cat, childIds: [...cat.childIds, ...newRooms.map((r) => r.id)] }
        : cat,
    );
  });

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

  let isLoneRoomVisible = $derived(
    !!page.params.object &&
      !roomsInSidebar.has(page.params.object as Ulid) &&
      !parentContext,
  );
</script>

<SidebarLayout loading={app.space.status === "loading"}>
  {#snippet header()}
    <SpaceSidebarHeader bind:isEditing />
  {/snippet}

  {#snippet saveAction()}
    {#if isEditing}
      <Button class="justify-start mb-4 mx-2 self-stretch" onclick={saveChanges}>
        <IconCheck class="size-4" />
        Finish editing</Button
      >
    {/if}
  {/snippet}

  {#snippet prefix()}
    {#if flags.threadsList}
      <Button
        class="w-full justify-start mb-2"
        variant="ghost"
        href={`/${page.params.space}/index`}
        data-current={page.url.pathname == `/${page.params.space}/index`}
      >
        <IconHome class="shrink-0" />
        Index
      </Button>

      {#if hasCalendar}
        <Button
          class="w-full justify-start mb-2"
          variant="ghost"
          href={`/${page.params.space}/calendar`}
          data-current={page.url.pathname == `/${page.params.space}/calendar`}
        >
          <IconCalendar class="shrink-0" />
          Events
        </Button>
      {/if}

      <hr class="my-2 border-base-800/10 dark:border-base-100/5" />
    {/if}
  {/snippet}

  {#snippet loneRoom()}
    {#if isLoneRoomVisible}
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
  {/snippet}

  {#snippet body()}
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
        {#each app.categories ?? [] as category (category.id)}
          <div class="flex items-start w-full" id={category.id}>
            <SidebarCategory bind:isEditing {editSidebarItem} {category} />
          </div>
        {/each}
      </div>
    {/if}
  {/snippet}

  {#snippet footer()}
    {#if isEditing}
      <Button
        class="mt-auto justify-start mb-4 mx-2 self-stretch"
        variant="ghost"
        onclick={() => (openRestoreRoomModal = true)}
      >
        <IconTrash class="size-4" />
        Archive
      </Button>
    {/if}
  {/snippet}
</SidebarLayout>

<EditRoomModal bind:open={openEditRoomModal} id={editingId} {renameCategory} />
<RestoreRoomModal bind:open={openRestoreRoomModal} />
