<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { schemas } from "@roomy-space/sdk";
  import { untrack } from "svelte";
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
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import {
    IconCheck,
    IconGripVertical,
    IconHome,
    IconTrash,
  } from "@roomy/design/icons";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { leaveSpace } from "$lib/mutations/space";
  import { updateSidebar } from "$lib/mutations/room";
  import { createQuery } from "@tanstack/svelte-query";
  import { transport, cache } from "@roomy-space/sdk";
  import { px } from "$lib/auth.svelte";
  import LinkedRoomList from "@roomy/design/components/sidebars/LinkedRoomList.svelte";
  import EditRoomModal from "./EditRoomModal.svelte";
  import RestoreRoomModal from "./RestoreRoomModal.svelte";
  import EditableChannelItem from "./EditableChannelItem.svelte";
  import InviteModal from "$lib/components/InviteModal.svelte";

  const { agentQuery } = transport;
  const { queryKey } = cache;

  type RoomMetadata = typeof schemas.queries.getRoomMetadata.Response.infer;

  type SidebarChannel =
    typeof schemas.queries.getSpaceMetadata.SidebarChannel.infer;
  type SidebarCategory =
    typeof schemas.queries.getSpaceMetadata.categories.infer;

  let { spaceId }: { spaceId: string } = $props();

  const metaQuery = createSpaceMetadataQuery(() => spaceId);

  let isEditing = $state(false);
  let editingId = $state<
    { room: string } | { categoryId: string; categoryName: string } | null
  >(null);
  let openEditRoomModal = $state(false);
  let openRestoreRoomModal = $state(false);
  let openInviteModal = $state(false);

  const meta = $derived(metaQuery.data);
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
      await leaveSpace(spaceId);
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
      draftOrder = categories.map((c) => ({
        id: c.id ?? c.name,
        childIds: c.channels.map((ch) => ch.id),
      }));
    }
    if (!isEditing && draftOrder) {
      draftOrder = null;
    }
  });

  $effect(() => {
    const currentCats = meta?.sidebar.categories;
    if (!currentCats) return;
    const currentDraft = untrack(() => draftOrder);
    if (!currentDraft) return;

    const draftRoomIds = new Set(currentDraft.flatMap((c) => c.childIds));
    const newRooms = currentCats
      .flatMap((c) => c.channels)
      .filter((r) => !draftRoomIds.has(r.id));

    if (newRooms.length === 0) return;

    draftOrder = currentDraft.map((cat, i) =>
      i === 0
        ? { ...cat, childIds: [...cat.childIds, ...newRooms.map((r) => r.id)] }
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
      await updateSidebar(spaceId, newSidebar);
    }
    draftOrder = null;
    isEditing = false;
  }
</script>

<SidebarLayout loading={metaQuery.isPending}>
  {#snippet header()}
    <SpaceHeaderShell
      spaceName={meta?.name ?? spaceId}
      isAdmin={meta?.isAdmin ?? false}
      {showInviteButton}
      bind:isEditing
      settingsHref={`/${spaceId}/settings`}
      {onInvite}
      {onLeave}
    >
      {#snippet avatar()}
        <SpaceAvatar src={meta?.avatar ?? undefined} id={spaceId} name={meta?.name ?? undefined} />
      {/snippet}
    </SpaceHeaderShell>
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
  {/snippet}

  {#snippet body()}
    {#if metaQuery.isError}
      <p class="px-2 text-sm text-red-600">{metaQuery.error.message}</p>
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

<InviteModal bind:open={openInviteModal} {spaceId} />

<EditRoomModal
  bind:open={openEditRoomModal}
  {spaceId}
  id={editingId}
  {renameCategory}
/>
<RestoreRoomModal bind:open={openRestoreRoomModal} {spaceId} />

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
    >
      {#if !isEditing && isActive && roomMetaQuery.data?.recentThreads?.length}
        <LinkedRoomList
          rooms={roomMetaQuery.data.recentThreads.map((t) => ({
            id: t.id,
            name: t.name ?? t.id,
            unreadCount: t.unreadCount,
            lastRead: -1,
          }))}
          currentRoomId={page.params.room}
          showUnreadCount={false}
          hrefFor={(threadId: string) => `/${spaceId}/${threadId}`}
        />
      {/if}
    </SidebarItemShell>
  </div>
{/snippet}
