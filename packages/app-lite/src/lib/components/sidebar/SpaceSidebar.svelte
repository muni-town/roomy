<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { schemas } from "@roomy-space/sdk";
  import { untrack } from "svelte";
  import { slide } from "svelte/transition";
  import ChannelPermissions from "$lib/components/ui/ChannelPermissions.svelte";
  import {
    type Permission,
  } from "$lib/mutations/room";
  import { sendEvents } from "$lib/mutations/send-events";
  import {
    dragHandleZone,
    dragHandle,
    SHADOW_ITEM_MARKER_PROPERTY_NAME,
  } from "svelte-dnd-action";
  import SidebarLayout from "@roomy/design/components/sidebars/SidebarLayout.svelte";
  import SpaceHeaderShell from "@roomy/design/components/sidebars/SpaceHeaderShell.svelte";
  import SidebarCategoryShell from "@roomy/design/components/sidebars/SidebarCategoryShell.svelte";
  import SidebarItemShell from "@roomy/design/components/sidebars/SidebarItemShell.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { resolveBlobUrl } from "$lib/utils";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import {
    IconCheck,
    IconGripVertical,
    IconHome,
    IconPlus,
    IconTrash,
  } from "@roomy/design/icons";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { leaveSpace } from "$lib/mutations/space";
  import { createRoom, updateSidebar } from "$lib/mutations/room";
  import { createQuery } from "@tanstack/svelte-query";
  import { transport, cache, newUlid } from "@roomy-space/sdk";
  import { px } from "$lib/auth.svelte";
  import LinkedRoomList from "@roomy/design/components/sidebars/LinkedRoomList.svelte";
  import EditRoomModal from "./EditRoomModal.svelte";
  import RestoreRoomModal from "./RestoreRoomModal.svelte";
  import EditableChannelItem from "./EditableChannelItem.svelte";
  import InviteModal from "$lib/components/InviteModal.svelte";
import CreateRoomModal from "@roomy/design/components/modals/CreateRoomModal.svelte";
import { createSpacesQuery } from "$lib/queries/spaces";

  const { agentQuery } = transport;
  const { queryKey } = cache;

  type RoomMetadata = typeof schemas.queries.getRoomMetadata.Response.infer;

  type SidebarChannel =
    typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;
  type SidebarCategory =
    typeof schemas.queries.getSpaceMetadata.categories.infer;

  let { spaceId }: { spaceId?: string } = $props();

  const metaQuery = createSpaceMetadataQuery(
    () => spaceId ?? "",
    { enabled: !!spaceId },
  );

  // --- Space picker mode — shows all joined spaces, current one highlighted ---
  const spacesQuery = createSpacesQuery({ includeLeft: true });
  // On the homepage (no spaceId), always show the space picker
  let showSpacePicker = $state(!spaceId);

  const joinedSpaces = $derived((spacesQuery.data?.spaces ?? []).filter((s) => s.isMember));

  function openSpacePicker() {
    if (!spaceId) return; // already in picker mode on homepage
    showSpacePicker = !showSpacePicker;
  }

  function navigateToSpace(targetSpaceId: string) {
    if (!spaceId) {
      goto(`/${targetSpaceId}`);
      return;
    }
    showSpacePicker = false;
    goto(`/${targetSpaceId}`);
  }

  let sidebarElement = $state<HTMLElement | null>(null);

  let isEditing = $state(false);

  $effect(() => {
    if (!showSpacePicker || !sidebarElement || !spaceId) return;

    function onPointerDown(e: PointerEvent) {
      // Ignore clicks on the space header toggle button
      if (sidebarElement && !sidebarElement.contains(e.target as Node)) {
        showSpacePicker = false;
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        showSpacePicker = false;
      }
    }

    // Use a microtask so the click that opened the picker doesn't immediately close it
    const handle = setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("keydown", onKeyDown);
    }, 0);

    return () => {
      clearTimeout(handle);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  });
  let editingId = $state<
    { room: string } | { categoryId: string; categoryName: string } | null
  >(null);
  let openEditRoomModal = $state(false);
  let openRestoreRoomModal = $state(false);
  let openInviteModal = $state(false);
  // Channel creation permissions state
  let createAccessMode = $state<"open" | "roles">("open");
  let createRolePermissions = $state<Record<string, Permission>>({});
  let createDefaultAccess = $state<Permission>("readwrite");

  let createModalOpen = $state(false);

  const meta = $derived(spaceId ? metaQuery.data : null);

  // Derive the current space from the cached getSpaces query for instant header rendering.
  // Falls back to getMetadata for future public spaces where this space isn't in the user's space list.
  const currentSpace = $derived(
    spaceId
      ? (spacesQuery.data?.spaces ?? []).find((s) => s.id === spaceId)
      : null,
  );
  const showInviteButton = $derived(
    (meta?.joinPolicy.allowPublicJoin ?? false) ||
      (meta?.joinPolicy.allowMemberInvites ?? false) ||
      (meta?.isAdmin ?? false),
  );

  function onInvite() {
    if (meta?.joinPolicy.allowPublicJoin) {
      const url = new URL(page.url.href);
      url.pathname = `/${spaceId}`;
      navigator.clipboard.writeText(url.href);
    } else {
      openInviteModal = true;
    }
  }

  async function onLeave() {
    try {
      await leaveSpace(spaceId!);
    } finally {
      goto("/");
    }
  }

  // --- Room metadata for thread-aware sidebar ---

  const roomMetaQuery = createQuery(() => ({
    queryKey: queryKey("space.roomy.room.getMetadata", {
      roomId: page.params.room ?? "",
    }),
    queryFn: () =>
      agentQuery(px(), "space.roomy.room.getMetadata", {
        roomId: page.params.room!,
      }),
    enabled: !!page.params.room,
  }));

  /**
   * The channel ID that should appear "active" in the sidebar.
   * - Direct match: user is on a channel (`page.params.room`)
   * - Parent match: user is on a thread, parent channel comes from server
   */
  const activeChannelId = $derived.by(() => {
    const room = page.params.room;
    if (!room) return null;
    if (channelMap.has(room)) return room;
    return roomMetaQuery.data?.parentChannelId ?? null;
  });

  function editSidebarItem(
    id: { room: string } | { categoryId: string; categoryName: string },
  ) {
    openEditRoomModal = true;
    editingId = id;
  }

  // --- Draft order for drag-and-drop reordering ---

  type DraftOrder = {
    id: string;
    childIds: string[];
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: boolean;
  }[];

  let draftOrder = $state<DraftOrder | null>(null);

  const categories = $derived(meta?.sidebar.categories ?? []);

  let categoryMap = $state(new Map<string, SidebarCategory>());

  $effect(() => {
    const cats = meta?.sidebar.categories ?? [];
    categoryMap = new Map(cats.map((c) => [c.id ?? c.name, c]));
  });

  const channelMap = $derived.by(() => {
    const map = new Map<string, SidebarChannel>();
    for (const cat of meta?.sidebar.categories ?? []) {
      for (const ch of cat.channels) {
        map.set(ch.id, ch);
      }
    }
    for (const ch of meta?.sidebar.orphans ?? []) {
      map.set(ch.id, ch);
    }
    return map;
  });

  // Build display categories, including orphans as a virtual group
  const displayCategories: (SidebarCategory & {
    [SHADOW_ITEM_MARKER_PROPERTY_NAME]?: boolean;
  })[] = $derived.by(() => {
    if (!draftOrder) {
      const cats = [...categories];
      const orphans = meta?.sidebar.orphans ?? [];
      if (orphans.length > 0) {
        cats.push({
          id: "__orphans__",
          name: "",
          position: cats.length,
          channels: orphans,
        } as SidebarCategory);
      }
      return cats;
    }

    return draftOrder
      .map((draft) => {
        const cat = categoryMap.get(draft.id);
        if (!cat) return null;
        return {
          ...cat,
          ...(draft[SHADOW_ITEM_MARKER_PROPERTY_NAME] && {
            [SHADOW_ITEM_MARKER_PROPERTY_NAME]: true,
          }),
          channels: draft.childIds
            .map((id) => channelMap.get(id))
            .filter((ch): ch is SidebarChannel => ch != null),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c != null);
  });

  $effect(() => {
    if (isEditing && !draftOrder) {
      const orphans = meta?.sidebar.orphans ?? [];
      if (categories.length === 0 && orphans.length > 0) {
        // No categories exist — show orphans in a virtual edit group
        draftOrder = [
          {
            id: "__orphans__",
            childIds: orphans.map((ch) => ch.id),
          },
        ];
      } else {
        draftOrder = categories.map((c, i) => ({
          id: c.id ?? c.name,
          childIds: [
            ...c.channels.map((ch) => ch.id),
            ...(i === 0 ? orphans.map((ch) => ch.id) : []),
          ],
        }));
      }
    }
    if (!isEditing && draftOrder) {
      draftOrder = null;
    }
  });

  $effect(() => {
    const currentCats = meta?.sidebar.categories;
    const currentOrphans = meta?.sidebar.orphans;
    if (!currentCats) return;
    const currentDraft = untrack(() => draftOrder);
    if (!currentDraft) return;

    const draftRoomIds = new Set(currentDraft.flatMap((c) => c.childIds));

    // Check for new rooms in categories that aren't in draft
    const newCategoryRooms = currentCats
      .flatMap((c) => c.channels)
      .filter((r) => !draftRoomIds.has(r.id));

    // Check for new orphan channels that aren't in draft
    const newOrphanRooms =
      currentOrphans?.filter((r) => !draftRoomIds.has(r.id)) ?? [];

    const allNewRooms = [...newCategoryRooms, ...newOrphanRooms];

    if (allNewRooms.length === 0) return;

    draftOrder = currentDraft.map((cat, i) =>
      i === 0
        ? { ...cat, childIds: [...cat.childIds, ...allNewRooms.map((r) => r.id)] }
        : cat,
    );
  });

  function handleCategoryReorder(newCategories: SidebarCategory[]) {
    draftOrder = newCategories.map((c) => ({
      id: c.id ?? c.name,
      childIds: c.channels.map((ch) => ch.id),
    }));
  }

  function handleRoomMove(
    categoryId: string,
    newChildren: SidebarCategory["channels"],
  ) {
    if (!draftOrder) return;
    draftOrder = draftOrder.map((cat) =>
      cat.id === categoryId
        ? { ...cat, childIds: newChildren.map((ch) => ch.id) }
        : cat,
    );
  }

  function renameCategory(id: string, newName: string) {
    const cat = categoryMap.get(id);
    if (!cat) return;
    categoryMap.set(id, { ...cat, name: newName });
    categoryMap = new Map(categoryMap);
  }

  async function saveChanges() {
    if (draftOrder) {
      const newSidebar = draftOrder
        .filter((c) => c.id !== "__orphans__")
        .map((c) => ({
          id: c.id,
          name: categoryMap.get(c.id)?.name ?? "",
          children: c.childIds,
        }));
      await updateSidebar(spaceId!, newSidebar);
    }
    draftOrder = null;
    isEditing = false;
  }

  async function handleCreate(opts: {
    type: "Channel" | "Category";
    name: string;
  }) {
    if (opts.type === "Category") {
      const cats = meta?.sidebar.categories ?? [];
      const newCategories = cats.map((c) => ({
        id: c.id ?? c.name,
        name: c.name,
        children: c.channels.map((ch) => ch.id),
      }));
      newCategories.push({
        id: newUlid(),
        name: opts.name,
        children: [],
      });
      await updateSidebar(spaceId!, newCategories);
    } else {
      const roomId = await createRoom(spaceId!, {
        kind: "space.roomy.channel",
        name: opts.name,
        ...(createDefaultAccess !== "readwrite" && {
          defaultAccess: createDefaultAccess,
        }),
      });

      // Send role permission events if access is role-based
      const permissionEvents =
        createAccessMode === "roles"
          ? Object.entries(createRolePermissions)
              .filter(([, perm]) => perm !== "none")
              .map(([roleId, permission]) => ({
                id: newUlid(),
                $type: "space.roomy.role.setRoleRoomPermission.v0",
                roleId,
                roomId,
                permission: permission as "read" | "readwrite",
              }))
          : [];

      if (permissionEvents.length > 0) {
        await sendEvents(spaceId!, permissionEvents);
      }

      goto(`/${spaceId}/${roomId}`);
    }
  }
</script>

<div bind:this={sidebarElement} class="h-full">
<SidebarLayout loading={!!spaceId && metaQuery.isPending}>
  {#snippet header()}
    {#if spaceId}
      <div class="pt-1">
        <SpaceHeaderShell
          spaceName={currentSpace?.name ?? meta?.name ?? spaceId}
          isAdmin={currentSpace?.isAdmin ?? meta?.isAdmin ?? false}
          {showInviteButton}
          bind:isEditing
          onSpacePicker={openSpacePicker}
          spacePickerActive={showSpacePicker}
          onNew={() => (createModalOpen = true)}
          settingsHref={`/${spaceId}/settings`}
          {onInvite}
          {onLeave}
        >
          {#snippet avatar()}
            <SpaceAvatar
              src={resolveBlobUrl(currentSpace?.avatar ?? meta?.avatar)}
              id={spaceId!}
              name={currentSpace?.name ?? meta?.name ?? undefined}
            />
          {/snippet}
        </SpaceHeaderShell>
      </div>
    {/if}
  {/snippet}

  {#snippet saveAction()}
    {#if spaceId && !showSpacePicker && isEditing}
      <Button class="justify-start mb-4 mx-2 self-stretch" onclick={saveChanges}>
        <IconCheck class="size-4" />
        Finish editing
      </Button>
    {/if}
  {/snippet}

  {#snippet prefix()}
    {#if spaceId && !showSpacePicker}
      <Button
        class="w-full justify-start mb-2"
        variant="ghost"
        href={`/${spaceId}`}
        data-current={page.url.pathname === `/${spaceId}`}
      >
        <IconHome class="shrink-0" />
        Index
      </Button>
      <hr class="my-2 border-base-800/10 dark:border-base-100/5" />
    {/if}
  {/snippet}

  {#snippet body()}
    {#if showSpacePicker}
      <div transition:slide class="py-2 space-y-1 pb-12">
        {#each joinedSpaces as space (space.id)}
          {#if space.id !== spaceId}
            <button
              onclick={() => navigateToSpace(space.id)}
              class="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-white dark:hover:bg-base-800 transition-colors text-left w-full cursor-pointer"
            >
              <SpaceAvatar
                src={resolveBlobUrl(space.avatar)}
                id={space.id}
                name={space.name ?? undefined}
                size={36}
              />
              <span class="text-sm font-medium text-base-700 dark:text-base-300 truncate flex-1">
                {space.name || "Unnamed Space"}
              </span>
            </button>
          {/if}
        {/each}
        
        <Button class="gap-3 mx-2" variant="ghost" href="/new">
          <IconPlus />
          Create Space
        </Button>
      </div>
    {/if}

    {#if !showSpacePicker}
      <div transition:slide>
        {#if metaQuery.isError}
          <p class="text-sm text-red-600">{metaQuery.error.message}</p>
        {:else if meta}
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
              onconsider={(e: any) => {
                draftOrder = e.detail.items.map((c: any) => ({
                  id: c.id ?? c.name,
                  childIds: (c.channels ?? []).map((ch: any) => ch.id),
                  [SHADOW_ITEM_MARKER_PROPERTY_NAME]:
                    c[SHADOW_ITEM_MARKER_PROPERTY_NAME],
                }));
              }}
              onfinalize={(e: any) => handleCategoryReorder(e.detail.items)}
            >
              {#each displayCategories as category (category[SHADOW_ITEM_MARKER_PROPERTY_NAME] ? `shadow-${category.id ?? category.name}` : category.id ?? category.name)}
                <div class="flex items-start w-full" id={category.id ?? category.name}>
                  <div
                    use:dragHandle
                    aria-label="drag-handle for {category.name}"
                    class="ml-2 mt-2.5 z-10"
                  >
                    <IconGripVertical class="size-3" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <SidebarCategoryShell
                      name={category.name}
                      items={category.channels}
                      {isEditing}
                      onEditCategory={() =>
                        editSidebarItem({
                          categoryId: category.id ?? category.name,
                          categoryName: category.name,
                        })}
                      onItemsReorder={(newChildren) =>
                        handleRoomMove(category.id ?? category.name, newChildren)}
                    >
                      {#snippet item(channel, _index)}
                        <EditableChannelItem
                          {channel}
                          {spaceId}
                          {isEditing}
                          active={activeChannelId === channel.id}
                          onedit={(roomId) => editSidebarItem({ room: roomId })}
                        />
                      {/snippet}
                    </SidebarCategoryShell>
                  </div>
                </div>
              {/each}
            </div>
          {:else}
            <div class="flex flex-col w-full min-h-4">
              {#each displayCategories as category (category.id ?? category.name)}
                {#if category.name}
                  <div class="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-base-400 dark:text-base-500">
                    {category.name}
                  </div>
                {/if}
                {#each category.channels as channel (channel.id)}
                  {@render channelItem(channel)}
                {/each}
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    {/if}
  {/snippet}

  {#snippet footer()}
    {#if spaceId && !showSpacePicker && isEditing}
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
</div>

{#if spaceId}
  <InviteModal bind:open={openInviteModal} {spaceId} />

  <EditRoomModal
    bind:open={openEditRoomModal}
    {spaceId}
    id={editingId}
    {renameCategory}
  />
  <RestoreRoomModal bind:open={openRestoreRoomModal} {spaceId} />

  <CreateRoomModal
    bind:open={createModalOpen}
    {spaceId}
    onCreate={handleCreate}
  >
    {#snippet permissions({ type })}
      {#if type === "Channel"}
        <ChannelPermissions
          {spaceId}
          bind:accessMode={createAccessMode}
          bind:rolePermissions={createRolePermissions}
          bind:defaultAccess={createDefaultAccess}
        />
      {/if}
    {/snippet}
  </CreateRoomModal>
{/if}

{#snippet channelItem(channel: SidebarChannel)}
  {@const isActive = activeChannelId === channel.id}
  <div class={!channel.canRead ? "opacity-50 pointer-events-none" : ""}>
    <SidebarItemShell
      variant="channel"
      name={channel.name ?? channel.id}
      href={`/${spaceId}/${channel.id}`}
      active={isActive}
      hasUnreadDot={channel.unreadCount > 0}
      unreadCount={channel.unreadCount}
      showUnreadCount={channel.unreadCount > 0}
    />
    {#if !isEditing && channel.activeThreads?.length}
      <LinkedRoomList
        rooms={channel.activeThreads.map((t) => ({
          id: t.id,
          name: t.name ?? t.id,
          unreadCount: t.unreadCount,
          lastRead: t.lastRead ? new Date(t.lastRead).getTime() : -1,
        }))}
        currentRoomId={page.params.room}
        showUnreadCount={true}
        hrefFor={(threadId: string) => `/${spaceId}/${threadId}`}
      />
    {/if}
  </div>
{/snippet}