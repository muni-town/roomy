<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { schemas } from "@roomy-space/sdk";
  import { untrack } from "svelte";
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
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import SidebarCategoryShell from "@roomy/design/components/sidebars/SidebarCategoryShell.svelte";
  import SidebarItemShell from "@roomy/design/components/sidebars/SidebarItemShell.svelte";
  import { resolveBlobUrl } from "$lib/utils";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import {
    IconCheck,
    IconGripVertical,
    IconHome,
    IconTrash,
  } from "@roomy/design/icons";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createRoomMetadataQuery } from "$lib/queries/room-metadata";
  import { leaveSpace } from "$lib/mutations/space";
  import { createRoom, updateSidebar } from "$lib/mutations/room";
  import { newUlid } from "@roomy-space/sdk";
  import { serverBar, toggleServerBar } from "$lib/components/layout/server-bar.svelte";
  import { setSidebarHeader } from "$lib/components/layout/sidebar.svelte";
  import LinkedRoomList from "@roomy/design/components/sidebars/LinkedRoomList.svelte";
  import SpaceSidebarButtons from "./SpaceSidebarButtons.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import EditRoomModal from "./EditRoomModal.svelte";
  import RestoreRoomModal from "./RestoreRoomModal.svelte";
  import EditableChannelItem from "./EditableChannelItem.svelte";
  import InviteModal from "$lib/components/InviteModal.svelte";
import CreateRoomModal from "@roomy/design/components/modals/CreateRoomModal.svelte";
import { createSpacesQuery } from "$lib/queries/spaces";
import { toast } from "@foxui/core";

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

  // Fetch metadata for the current room so we can inject the current thread
  // into the sidebar even when it's not among the recent 8 active threads.
  const roomMetaQuery = createRoomMetadataQuery(
    () => page.params.room ?? "",
    { enabled: !!page.params.room },
  );

  const spacesQuery = createSpacesQuery({ includeLeft: true });

  // --- Server bar toggle — the space header (avatar) toggles it. ---
  let sidebarElement = $state<HTMLElement | null>(null);

  let isEditing = $state(false);
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

  let createChannelOpen = $state(false);
  let createCategoryOpen = $state(false);

  const meta = $derived(spaceId ? metaQuery.data : null);

  // Register the space header so MainLayout can render it as a full-width bar
  // above the server bar / BigSidebar row (matching the user card behaviour).
  // The snippet is defined below in the template and closes over this scope.
  $effect(() => {
    setSidebarHeader(spaceHeader);
    return () => setSidebarHeader(undefined);
  });

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
      navigator.clipboard.writeText(url.href).then(() => {
        toast.success("Invite link copied to clipboard");
      });
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

  /**
   * The channel ID that should appear "active" in the sidebar.
   * Only channels (not threads) get the active highlight — threads are
   * highlighted separately via LinkedRoomList's data-current attribute.
   */
  const activeChannelId = $derived.by(() => {
    const room = page.params.room;
    if (!room) return null;
    if (channelMap.has(room)) return room;
    // Thread: don't mark the parent channel as active; the thread itself
    // is highlighted by LinkedRoomList via currentRoomId.
    return null;
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

  /**
   * Threads to show under each channel in the sidebar.
   * Merges the server's activeThreads (up to 8 recent) with the current
   * thread if it's a thread that belongs to this channel and isn't already
   * in the list. This ensures the currently-viewed thread always appears
   * in the sidebar even when it's not among the recent 8.
   */
  const threadsByChannel = $derived.by(() => {
    const map = new Map<
      string,
      Array<{
        id: string;
        name: string;
        unreadCount: number;
        lastRead: number;
      }>
    >();

    // Start with server-side active threads
    for (const cat of meta?.sidebar.categories ?? []) {
      for (const ch of cat.channels) {
        if (ch.activeThreads?.length) {
          map.set(
            ch.id,
            ch.activeThreads.map((t) => ({
              id: t.id,
              name: t.name ?? t.id,
              unreadCount: t.unreadCount,
              lastRead: t.lastRead ? new Date(t.lastRead).getTime() : -1,
            })),
          );
        }
      }
    }
    for (const ch of meta?.sidebar.orphans ?? []) {
      if (ch.activeThreads?.length) {
        map.set(
          ch.id,
          ch.activeThreads.map((t) => ({
            id: t.id,
            name: t.name ?? t.id,
            unreadCount: t.unreadCount,
            lastRead: t.lastRead ? new Date(t.lastRead).getTime() : -1,
          })),
        );
      }
    }

    // If the current room is a thread, inject it into its parent channel
    const currentRoom = page.params.room;
    const roomMeta = roomMetaQuery.data;
    if (currentRoom && roomMeta?.kind === "thread" && roomMeta.parentChannelId) {
      const parentId = roomMeta.parentChannelId;
      const existing = map.get(parentId) ?? [];
      if (!existing.some((t) => t.id === currentRoom)) {
        map.set(parentId, [
          ...existing,
          {
            id: currentRoom,
            name: roomMeta.name ?? currentRoom,
            unreadCount: roomMeta.unreadCount ?? 0,
            lastRead: roomMeta.lastRead
              ? new Date(roomMeta.lastRead).getTime()
              : -1,
          },
        ]);
      }
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

{#snippet spaceHeader()}
  {#if spaceId}
    <div class="border-b border-transparent hover:border-base-200/60 dark:hover:border-base-900/60">
      <SpaceHeaderShell
        spaceName={currentSpace?.name ?? meta?.name ?? spaceId}
        isAdmin={currentSpace?.isAdmin ?? meta?.isAdmin ?? false}
        {showInviteButton}
        spaceSelectorOpen={serverBar.expanded}
        onToggleSpaceSelector={toggleServerBar}
        bind:isEditing
        onCreateChannel={() => (createChannelOpen = true)}
        onCreateCategory={() => (createCategoryOpen = true)}
        settingsHref={`/${spaceId}/settings`}
        {onInvite}
        {onLeave}
      >
        {#snippet avatar()}
          <SpaceAvatar
            src={resolveBlobUrl(meta?.avatar)}
            id={spaceId}
            name={meta?.name ?? undefined}
            shape="squircle"
          />
        {/snippet}
      </SpaceHeaderShell>
    </div>
  {/if}
{/snippet}

<div bind:this={sidebarElement} class="h-full">
<SidebarLayout loading={!!spaceId && metaQuery.isPending}>
  {#snippet actions()}
    <SpaceSidebarButtons
      {spaceId}
      allowPublicJoin={meta?.joinPolicy.allowPublicJoin ?? false}
      onInvite={onInvite}
    />
  {/snippet}

  {#snippet saveAction()}
    {#if spaceId && isEditing}
      <Button class="justify-start mb-4 mx-2 self-stretch" variant="secondary" size="sm" onclick={saveChanges}>
        <IconCheck class="size-4" />
        Finish editing
      </Button>
    {/if}
  {/snippet}

  {#snippet prefix()}
    {#if spaceId}
      <Button
        class="w-full justify-start min-w-0 py-1"
        variant="ghost"
        href={`/${spaceId}`}
        data-current={page.url.pathname === `/${spaceId}`}
      >
        <IconHome class="shrink-0" />
        <span class="truncate min-w-0 whitespace-nowrap overflow-hidden font-semibold">Index</span>
      </Button>
      <hr class="my-2 border-base-800/10 dark:border-base-100/5" />
    {/if}
  {/snippet}

  {#snippet body()}
    {#if metaQuery.isError}
      <ErrorMessage message={metaQuery.error.message} class="px-4 py-3" />
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
                class="ml-2 mt-2.5 z-10 text-base-400 dark:text-base-500"
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
  {/snippet}

  {#snippet footer()}
    {#if spaceId && isEditing}
      <Button
        class="mt-auto justify-start mb-4 mx-2 self-stretch"
        variant="secondary"
        size="sm"
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
    bind:open={createChannelOpen}
    {spaceId}
    defaultType="Channel"
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

  <CreateRoomModal
    bind:open={createCategoryOpen}
    {spaceId}
    defaultType="Category"
    onCreate={handleCreate}
  />
{/if}

{#snippet channelItem(channel: SidebarChannel)}
  {@const isActive = activeChannelId === channel.id}
  {@const channelThreads = threadsByChannel.get(channel.id)}
  <div class={!channel.canRead ? "opacity-50 pointer-events-none" : ""}>
    <SidebarItemShell
      variant="channel"
      name={channel.name ?? channel.id}
      href={`/${spaceId}/${channel.id}`}
      active={isActive}
      hasUnreadDot={channel.unreadCount > 0}
      hasUnread={channel.unreadCount > 0}
    />
    {#if !isEditing && channelThreads?.length}
      <LinkedRoomList
        rooms={channelThreads}
        currentRoomId={page.params.room}
        hrefFor={(threadId: string) => `/${spaceId}/${threadId}`}
      />
    {/if}
  </div>
{/snippet}