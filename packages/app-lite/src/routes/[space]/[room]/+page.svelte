<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { page } from "$app/state";
  import { useTopicSubscription } from "@roomy-space/sdk/svelte";
  import type { Topic } from "@roomy-space/sdk/svelte";
  import { sync_ } from "$lib/sync.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setCurrentRoom } from "$lib/components/layout/current-room.svelte";
  import { spaceNavigation } from "$lib/components/layout/last-room.svelte";
  import { closeToolbar, messagingState } from "$lib/components/chat/messaging-state.svelte";
  import ToggleTabs from "@roomy/design/components/layout/ToggleTabs.svelte";
  import { createRoomMetadataQuery } from "$lib/queries/room-metadata";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { updateSeen } from "$lib/mutations/update-seen";
  import { deleteMessage, deleteMessages } from "$lib/mutations/message";
  import DeleteMessageDialog from "@roomy/design/components/content/thread/message/DeleteMessageDialog.svelte";
  import { auth } from "$lib/auth.svelte";
  import { toast } from "@foxui/core";
  import ChatArea from "$lib/components/chat/ChatArea.svelte";
  import ChatInputArea from "$lib/components/chat/ChatInputArea.svelte";
  import RoomPickerModal from "$lib/components/chat/RoomPickerModal.svelte";
  import type { Message } from "$lib/queries/messages";
  import ChannelBoardView from "$lib/components/thread/ChannelBoardView.svelte";
  import LinksView from "$lib/components/thread/LinksView.svelte";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import SeoMeta from "$lib/components/seo/SeoMeta.svelte";
  import { resolveBlobUrl } from "$lib/utils";

  const spaceId = $derived(page.params.space!);
  const roomId = $derived(page.params.room!);
  // Search deep-link target (`?message=`), e.g. from search results or a
  // forward context link — ChatArea scrolls to and briefly highlights it.
  const highlightMessage = $derived(
    page.url.searchParams.get("message") ?? undefined,
  );

  // ── Forward modal ───────────────────────────────────────────────────────
  // Owned here (not ChatArea/ChatInputArea) so both the per-message toolbar
  // forward and select mode's multi-message forward share one modal, and its
  // state survives hover-toolbar and select-mode lifetimes. `forwardSource`
  // is the source room for the messages being forwarded.
  let forwardMessages = $state<Message[] | null>(null);
  let isForwardModalOpen = $state(false);
  let forwardSourceRoom = $state<string | null>(null);

  function openForward(messages: Message[]) {
    forwardMessages = messages;
    forwardSourceRoom = roomId;
    isForwardModalOpen = true;
  }

  // ── Move modal ──────────────────────────────────────────────────────────
  // Same ownership rationale as the forward modal. Moves are admin-only (the
  // Move action is gated in ChatMessage's toolbar and the select-mode bar);
  // the modal reuses the forward room picker in "move" mode.
  let moveTargets = $state<Message[] | null>(null);
  let isMoveModalOpen = $state(false);
  let moveSourceRoom = $state<string | null>(null);

  function openMove(messages: Message[]) {
    moveTargets = messages;
    moveSourceRoom = roomId;
    isMoveModalOpen = true;
  }

  // ── Delete confirmation ─────────────────────────────────────────────────
  // Same ownership rationale as the forward/move modals: one dialog serves the
  // per-message toolbar delete (raised through ChatArea → here) and select
  // mode's admin batch delete (raised through ChatInputArea → here), so it
  // outlives whichever subtree raised it.
  let deleteTargets = $state<Message[]>([]);
  let isDeleteConfirmOpen = $state(false);

  function openDeleteConfirm(messages: Message[]) {
    if (messages.length === 0) return;
    deleteTargets = messages;
    isDeleteConfirmOpen = true;
  }

  /** Other authors in the selection — the admin case, where deleting removes
   *  someone else's words. Deduped by DID; falls back to the DID when no
   *  profile name resolved. */
  const deleteOtherAuthors = $derived.by(() => {
    const names = new Map<string, string>();
    for (const m of deleteTargets) {
      if (!m.authorDid || m.authorDid === currentUserDid) continue;
      if (!names.has(m.authorDid)) {
        names.set(m.authorDid, m.authorName ?? m.authorDid);
      }
    }
    return Array.from(names.values());
  });

  /**
   * Confirm the delete. A single message from the per-message toolbar keeps
   * the original single-event path; anything else — including a one-message
   * *selection* — is sent as ONE `sendEvents` batch of delete events, so the
   * select-mode teardown below applies to every selection size.
   *
   * No optimistic removal: queries hold `staleTime: Infinity`, so the messages
   * leave the timeline from the server's `#messageDiff` remove ops.
   */
  async function confirmDelete() {
    const targets = deleteTargets;
    if (targets.length === 0) return;
    const selecting = messagingState.current.kind === "selecting";

    if (targets.length === 1 && !selecting) {
      await deleteMessage(effectiveSpaceId, roomId, targets[0]!.id);
      return;
    }

    await deleteMessages(
      effectiveSpaceId,
      roomId,
      targets.map((m) => m.id),
    );
    toast.success(
      `Deleted ${targets.length} message${targets.length > 1 ? "s" : ""}`,
    );
    // Leave select mode once the selection is consumed, matching the forward
    // and move flows.
    if (selecting) messagingState.setNormal();
  }

  useTopicSubscription(
    () => sync_.ctx?.topicManager ?? null,
    () => [{ kind: "room", id: roomId } satisfies Topic],
  );

  $effect(() => {
    // Composer document activation is owned by ChatInputArea ($effect.pre on
    // roomId) so the editor always seeds from the recalled per-room draft
    // before its subtree mounts. Here: drop the mobile toolbar from a
    // previous room and point the sync connection at the new room. Writes to
    // module-level $state are wrapped in untrack() to avoid reactive cascades
    // (effect_update_depth_exceeded).
    untrack(() => {
      closeToolbar();
      // Selecting is room-scoped: cancel it when leaving the room so a stale
      // selection never carries into the next room's composer.
      if (
        messagingState.current.kind === "selecting" ||
        messagingState.current.kind === "threading"
      ) {
        messagingState.setNormal();
      }
      sync_.setActiveRoom(roomId);
    });
    updateSeen(roomId).catch(() => {});
    return () => {
      untrack(() => {
        if (sync_.activeRoomId === roomId) sync_.setActiveRoom(null);
      });
    };
  });

  onMount(() => {
    setNavbar(roomNavbar);
    return () => {
      setNavbar(undefined);
      setCurrentRoom(null);
    };
  });

  const roomQuery = createRoomMetadataQuery(() => roomId, {
    enabled: () => !!roomId,
  });
  const spaceMetaQuery = createSpaceMetadataQuery(() => spaceId);

  /**
   * Derive room display info from the already-cached getSpaceMetadata sidebar
   * data (shared with the layout + sidebar) so the navbar renders instantly
   * without waiting for a separate room metadata fetch.
   *
   * Searches sidebar channels first, then nested activeThreads.
   * Falls back to the dedicated room metadata query for rooms not in the
   * sidebar (e.g., threads that aren't active enough to appear there).
   */
  const sidebarRoomInfo = $derived.by<{
    id: string;
    name?: string;
    kind: "channel" | "thread";
    unreadCount: number;
    canRead: boolean;
    canWrite: boolean;
    lastRead?: string | null;
    parentChannelId?: string;
    parentChannelName?: string;
    federated?: {
      originSpaceId: string;
      originSpaceName?: string;
      originSpaceAvatar?: string;
      permission: "read" | "readwrite";
    };
  } | null>(() => {
    const meta = spaceMetaQuery.data;
    if (!meta) return null;

    for (const cat of meta.sidebar.categories) {
      for (const ch of cat.channels) {
        if (ch.id === roomId) return { ...ch, kind: "channel" as const };
        if (ch.activeThreads) {
          for (const t of ch.activeThreads) {
            if (t.id === roomId) return { ...t, kind: "thread" as const, parentChannelId: ch.id, parentChannelName: ch.name };
          }
        }
      }
    }

    for (const ch of meta.sidebar.orphans) {
      if (ch.id === roomId) return { ...ch, kind: "channel" as const };
      if (ch.activeThreads) {
        for (const t of ch.activeThreads) {
          if (t.id === roomId) return { ...t, kind: "thread" as const, parentChannelId: ch.id, parentChannelName: ch.name };
        }
      }
    }

    return null;
  });

  // Use sidebar data when available (instant from cache), fall back to room query.
  const roomName = $derived(
    sidebarRoomInfo?.name ?? roomQuery.data?.name ?? "Channel",
  );
  const roomUnreadCount = $derived(
    sidebarRoomInfo?.unreadCount ?? roomQuery.data?.unreadCount ?? 0,
  );
  const roomUnreadThreadCount = $derived(
    roomQuery.data?.unreadThreadCount ?? 0,
  );
  const roomKind = $derived(
    sidebarRoomInfo?.kind ?? roomQuery.data?.kind,
  );
  const roomCanWrite = $derived(
    sidebarRoomInfo?.canWrite ?? roomQuery.data?.canWrite,
  );

  // Private (invite-only) spaces don't yet support private media uploads —
  // gate the composer's upload UI until PDS-side access control lands.
  const disableUploads = $derived(
    spaceMetaQuery.data?.joinPolicy.allowPublicJoin === false,
  );

  // Push room info to NavbarSpaceInfo — reactive so it updates when sidebar cache loads
  $effect(() => {
    const name = roomName;
    const kind = roomKind;
    const parentId = sidebarRoomInfo?.parentChannelId;
    const parentName = sidebarRoomInfo?.parentChannelName;
    untrack(() => {
      setCurrentRoom({
        id: roomId,
        name,
        kind: kind === "thread" ? "thread" : "channel",
        parentChannelId: parentId,
        parentChannelName: parentName,
        ...(sidebarRoomInfo?.federated
          ? {
              federatedOrigin: {
                id: sidebarRoomInfo.federated.originSpaceId,
                name: sidebarRoomInfo.federated.originSpaceName,
                avatar: sidebarRoomInfo.federated.originSpaceAvatar,
              },
            }
          : {}),
      });
    });
  });

  // ── Tab state ─────────────────────────────────────────────────────────────
  // The Chat/Threads tab is per-entry state: it starts in Chat on every room
  // visit, so navigating from a channel in Threads view to another channel
  // always lands in Chat.
  // The Links tab is gated behind the "links-view" feature flag: it only
  // appears once an admin has enabled the flag. All flags default false.
  const flagsQuery = createFeatureFlagsQuery();
  const linksViewEnabled = $derived(
    flagsQuery.data?.flags.includes("links-view") ?? false,
  );
  const channelTabList = $derived(
    linksViewEnabled
      ? (["Chat", "Threads", "Links"] as const)
      : (["Chat", "Threads"] as const),
  );
  let channelActiveTab = $state<(typeof channelTabList)[number]>("Chat");

  // Reset to Chat whenever the room changes. Navigating between rooms reuses
  // this page component (same route pattern), so without this the tab would
  // carry over from the previous room. Declared before the hash effect below
  // so an explicit URL hash (ToggleTabs navigation, back/forward) wins.
  $effect(() => {
    void roomId; // track room changes
    channelActiveTab = "Chat";
  });

  // Sync tab state from URL hash — clicking a toggle tab navigates to the hash,
  // which gives the user working browser back/forward between views.
  // Only reacts when a hash is present; on initial load with no hash the
  // default "Chat" is preserved.
  $effect(() => {
    if (page.url.hash === "#chat") {
      channelActiveTab = "Chat";
    } else if (page.url.hash === "#threads") {
      channelActiveTab = "Threads";
    } else if (page.url.hash === "#links" && linksViewEnabled) {
      channelActiveTab = "Links";
    }
  });

  // Remember the last room in this space so the server bar and space switcher
  // can redirect back to it when re-entering the space.
  $effect(() => {
    spaceNavigation.set(spaceId, { kind: "room", id: roomId });
  });


  // Only show chat input area in chat view and when not a thread
  let showChatInput = $derived(roomKind === "channel" && channelActiveTab === "Chat");

  /** Computes the original space ID if the channel was federated, otherwise it's just the current space ID. */
  let effectiveSpaceId = $derived(sidebarRoomInfo?.federated?.originSpaceId || spaceId);

  // Space admin status of the room's own space — gates the Move action (the
  // toolbar item, the select-mode button, and the modal). Same query key as
  // ChatArea's own `isAdmin` derivation, so the two share one request.
  // Defaults false while the query loads: an unknown viewer gets no Move.
  const roomSpaceMetaQuery = createSpaceMetadataQuery(() => effectiveSpaceId);
  const isAdmin = $derived(roomSpaceMetaQuery.data?.isAdmin ?? false);
  /** Current user's DID — distinguishes "my own message" from moderation. */
  const currentUserDid = $derived(auth.userDid);
</script>

<SeoMeta
  title={roomName !== "Channel" ? `${roomName} - ${spaceMetaQuery.data?.name ?? "Roomy"}` : spaceMetaQuery.data?.name ? `${spaceMetaQuery.data.name} - Roomy` : "Roomy"}
  description={spaceMetaQuery.data?.description}
  image={spaceMetaQuery.data?.avatar ? resolveBlobUrl(spaceMetaQuery.data.avatar) : undefined}
  url={page.url.origin ? `${page.url.origin}/${spaceId}/${roomId}` : undefined}
/>

{#snippet roomNavbar()}
  <div class="flex items-center gap-2 px-2 min-w-0 grow">
    {#if roomUnreadCount > 0}
      <span class="text-xs bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400 px-2 py-0.5 rounded-full">
        {roomUnreadCount} unread
      </span>
    {/if}

    {#if roomKind === "channel"}
      <!-- On narrow navbar containers the toggle floats right-aligned,
           immediately left of the search icon; once the container is wide
           enough for the searchbar it centers in the navbar. -->
      <span class="grow @min-[40rem]:hidden"></span>
      <div
        class="@min-[40rem]:absolute @min-[40rem]:left-1/2 @min-[40rem]:top-1/2 @min-[40rem]:-translate-x-1/2 @min-[40rem]:-translate-y-1/2"
      >
        <ToggleTabs
          items={channelTabList.map((x) => ({
            name: x,
            href: `#${x.toLowerCase()}`,
            badge: x === "Threads" ? roomUnreadThreadCount : undefined,
          }))}
          active={channelActiveTab}
        />
      </div>
    {/if}
  </div>
{/snippet}

<div class="h-full flex flex-col bg-white dark:bg-base-900/20">
  {#if roomKind === "channel"}
    <!-- Both ChatArea and ChannelBoardView stay mounted for smooth tab switching -->
    <div class="relative flex-1 min-h-0">
      <!-- Chat view - always rendered but visibility toggled -->
      <div class="absolute inset-0 flex flex-col" class:hidden={channelActiveTab !== "Chat"}>
        <ChatArea spaceId={effectiveSpaceId} {roomId} {highlightMessage} onSeen={() => { if (roomUnreadCount > 0) updateSeen(roomId).catch(() => {}); }} onForward={openForward} onMove={openMove} onRequestDelete={openDeleteConfirm} /> 
      </div>

      <!-- Threads view - always rendered but visibility toggled -->
      <div class="absolute inset-0" class:hidden={channelActiveTab !== "Threads"}>
        <ChannelBoardView />
      </div>

      <!-- Links view - always rendered but visibility toggled; only mounted
           when the links-view feature flag is enabled. -->
      {#if linksViewEnabled}
        <div class="absolute inset-0" class:hidden={channelActiveTab !== "Links"}>
          <LinksView />
        </div>
      {/if}
    </div>

    <!-- Chat input area - only shown in chat view -->
    {#if showChatInput}
      <!-- Keyed per room: the Tiptap editor holds its document internally, so
           without a remount an editor carried across room switches keeps the
           previous room's text. Remounting re-seeds from the recalled per-room
           composer document (draft string + blocks). -->
      {#key roomId}
        <ChatInputArea spaceId={effectiveSpaceId} {roomId} canWrite={roomCanWrite} {disableUploads} onForwardSelection={openForward} onMoveSelection={isAdmin ? openMove : undefined} onDeleteSelection={isAdmin ? openDeleteConfirm : undefined} />
      {/key}
    {/if}
  {:else}
    <!-- Thread rooms only have chat view -->
    <ChatArea spaceId={effectiveSpaceId} {roomId} {highlightMessage} onSeen={() => { if (roomUnreadCount > 0) updateSeen(roomId).catch(() => {}); }} onForward={openForward} onMove={openMove} onRequestDelete={openDeleteConfirm} />
    {#key roomId}
      <ChatInputArea spaceId={effectiveSpaceId} {roomId} canWrite={roomCanWrite} {disableUploads} onForwardSelection={openForward} />
    {/key}
  {/if}

  {#if forwardMessages && forwardSourceRoom}
    <RoomPickerModal
      bind:open={isForwardModalOpen}
      spaceId={effectiveSpaceId}
      fromRoomId={forwardSourceRoom}
      messages={forwardMessages}
    />
  {/if}

  {#if moveTargets && moveSourceRoom}
    <RoomPickerModal
      bind:open={isMoveModalOpen}
      mode="move"
      spaceId={effectiveSpaceId}
      fromRoomId={moveSourceRoom}
      messages={moveTargets}
    />
  {/if}

  <DeleteMessageDialog
    bind:open={isDeleteConfirmOpen}
    authorName={deleteTargets[0]?.authorName}
    isAdminDelete={deleteTargets.length === 1 &&
      !!deleteTargets[0] &&
      deleteTargets[0].authorDid !== currentUserDid &&
      isAdmin}
    count={deleteTargets.length}
    otherAuthors={deleteOtherAuthors}
    onConfirm={confirmDelete}
  />
</div>
