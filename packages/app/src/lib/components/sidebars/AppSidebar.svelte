<script lang="ts">
  import { page } from "$app/state";
  import { getAppState } from "$lib/queries";
  import { peer } from "$lib/workers";
  import { flags } from "$lib/config";
  import { joinSpace } from "$lib/mutations/space";

  import SpaceAvatar from "../spaces/SpaceAvatar.svelte";
  import SpaceSidebarHeader from "./SpaceSidebarHeader.svelte";
  import SidebarCategory from "./SidebarCategory.svelte";
  import SidebarLayout from "@roomy/design/components/sidebars/SidebarLayout.svelte";
  import EntityName from "../helper/EntityName.svelte";

  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import EditRoomModal from "../modals/EditRoomModal.svelte";
  import RestoreRoomModal from "../modals/RestoreRoomModal.svelte";

  import {
    IconCalendar,
    IconHome,
    IconHashtag,
    IconGripVertical,
    IconTrash,
    IconCheck,
    IconPlus,
  } from "@roomy/design/icons";

  import { type SidebarCategory as SidebarCategoryType } from "$lib/queries";
  import { newUlid, Ulid } from "@roomy-space/sdk";

  import { untrack } from "svelte";
  import {
    dragHandleZone,
    dragHandle,
    SHADOW_ITEM_MARKER_PROPERTY_NAME,
  } from "svelte-dnd-action";
  import { calendarLinkQuery } from "$lib/queries/calendar.svelte";

  const app = getAppState();

  // ── Mode detection ──────────────────────────────────────────
  const isHome = $derived(
    page.url.pathname === "/home" || page.url.pathname === "/",
  );

  // ── Editing state (space sidebar) ───────────────────────────
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

  let openEditRoomModal = $state(false);
  let openRestoreRoomModal = $state(false);

  // ── Space sidebar data ──────────────────────────────────────
  const roomsInSidebar = $derived(
    new Set([
      ...(app.categories?.flatMap((cat) =>
        cat.children.map((child) => child.id),
      ) || []),
    ]),
  );

  const parentContext = $derived(page.url.searchParams.get("parent"));
  const spaceId = $derived(app.joinedSpace?.id ?? page.params.space);
  let isLoneRoomVisible = $derived(
    !!page.params.object &&
      !roomsInSidebar.has(page.params.object as Ulid) &&
      !parentContext,
  );

  let calendarLink = $derived(
    flags.calendar && spaceId && calendarLinkQuery(spaceId),
  );
  let hasCalendar = $derived(
    (calendarLink && calendarLink.result && calendarLink.result.length) ||
      0 > 0,
  );

  // ── Sidebar editing & drag-drop ─────────────────────────────
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
  let roomMap = $derived(
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

  function renameCategory(id: Ulid, newName: string) {
    const category = categoryMap.get(id);
    const renamed = {
      ...category,
      name: newName,
    } as SidebarCategoryType;
    categoryMap.set(id, renamed);
    categoryMap = new Map(categoryMap);
  }

  // ── Home sidebar: rejoin space ──────────────────────────────
  let rejoining = $state<string | null>(null);

  async function rejoin(spaceId: string) {
    rejoining = spaceId;
    try {
      await joinSpace(spaceId as any);
    } catch (e) {
      console.error("Failed to rejoin space", e);
    } finally {
      rejoining = null;
    }
  }
</script>

{#if isHome}
  <!-- ────── HOME SIDEBAR ────── -->
  <div class="flex flex-col h-full">
    <!-- Home button at top -->
    <div class="flex items-center justify-between px-4 pt-3 pb-2">
      <h2 class="text-lg font-bold text-base-900 dark:text-base-100">Spaces</h2>
    </div>

    <!-- Space list (scrollable area fills remaining space after header and user card) -->
    <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
      {#if app.spaces.length > 0}
        <section class="flex flex-col gap-0.5" aria-label="Your Spaces">
          {#each app.spaces as space (space.id)}
            <a
              href={`/${space.handle || space.id}`}
              class="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-base-200 dark:hover:bg-base-800 transition-colors no-underline"
            >
              <SpaceAvatar
                imageUrl={space.avatar}
                id={space.id}
                size={36}
                loading={space.backfill_status !== "idle"}
              />
              <span class="text-sm font-medium text-base-700 dark:text-base-300 truncate">
                {space.name || "Unnamed Space"}
              </span>
            </a>
          {/each}
        </section>
      {:else}
        <p class="text-sm text-base-400 px-2 pt-2">
          <Button href="/new" variant="ghost" class="gap-2">
            <IconPlus class="size-4" />
            Create a Space
          </Button>
        </p>
      {/if}

      <!-- Left spaces -->
      {#if app.leftSpaces.length > 0}
        <details class="mt-4">
          <summary class="text-xs font-medium opacity-60 cursor-pointer select-none hover:opacity-100 px-3 py-1 transition-opacity">
            Left Spaces ({app.leftSpaces.length})
          </summary>
          <div class="flex flex-col gap-0.5 mt-1">
            {#each app.leftSpaces as space}
              <div class="flex items-center gap-3 rounded-lg px-3 py-2 opacity-60 hover:opacity-100 transition-opacity">
                <SpaceAvatar
                  imageUrl={space.avatar}
                  id={space.id}
                  name={space.name}
                  size={28}
                />
                <span class="text-sm text-base-500 dark:text-base-400 truncate flex-1">
                  {space.name || "Unnamed Space"}
                </span>
                <button
                  onclick={() => rejoin(space.id)}
                  disabled={rejoining === space.id}
                  class="text-xs text-accent-500 hover:text-accent-400 disabled:opacity-50"
                >
                  {rejoining === space.id ? "…" : "Rejoin"}
                </button>
              </div>
            {/each}
          </div>
        </details>
      {/if}
    </div>
  </div>
{:else}
  <!-- ────── SPACE SIDEBAR ────── -->
  <SidebarLayout loading={app.space.status === "loading"}>
    {#snippet header()}
      <SpaceSidebarHeader bind:isEditing />
    {/snippet}

    {#snippet saveAction()}
      {#if isEditing}
        <Button class="justify-start mb-4 mx-2 self-stretch" onclick={saveChanges}>
          <IconCheck class="size-4" />
          Finish editing
        </Button>
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
          <span class="truncate whitespace-nowrap overflow-hidden min-w-0 font-semibold">
            <EntityName id={Ulid.assert(page.params.object)} />
          </span>
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
{/if}

<EditRoomModal bind:open={openEditRoomModal} id={editingId} {renameCategory} />
<RestoreRoomModal bind:open={openRestoreRoomModal} />