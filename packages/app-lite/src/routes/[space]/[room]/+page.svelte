<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { page } from "$app/state";
  import { useTopicSubscription } from "@roomy-space/sdk/svelte";
  import type { Topic } from "@roomy-space/sdk/svelte";
  import { sync_ } from "$lib/sync.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setCurrentRoom } from "$lib/components/layout/current-room.svelte";
  import { spaceNavigation } from "$lib/components/layout/last-room.svelte";
  import { messagingState } from "$lib/components/chat/messaging-state.svelte";
  import ToggleTabs from "@roomy/design/components/layout/ToggleTabs.svelte";
  import { createRoomMetadataQuery } from "$lib/queries/room-metadata";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { updateSeen } from "$lib/mutations/update-seen";
  import ChatArea from "$lib/components/chat/ChatArea.svelte";
  import ChatInputArea from "$lib/components/chat/ChatInputArea.svelte";
  import ChannelBoardView from "$lib/components/thread/ChannelBoardView.svelte";

  const spaceId = $derived(page.params.space!);
  const roomId = $derived(page.params.room!);

  useTopicSubscription(
    () => sync_.ctx?.topicManager ?? null,
    () => [{ kind: "room", id: roomId } satisfies Topic],
  );

  $effect(() => {
    // Reset any lingering reply/thread context from a previous room.
    // Writes to module-level $state are wrapped in untrack() to avoid
    // reactive cascades (effect_update_depth_exceeded).
    untrack(() => {
      messagingState.setNormal();
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

  const roomQuery = createRoomMetadataQuery(() => roomId);
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
  const sidebarRoomInfo = $derived.by(() => {
    const meta = spaceMetaQuery.data;
    if (!meta) return null;

    for (const cat of meta.sidebar.categories) {
      for (const ch of cat.channels) {
        if (ch.id === roomId) return { ...ch, kind: "channel" as const };
        if (ch.activeThreads) {
          for (const t of ch.activeThreads) {
            if (t.id === roomId) return { ...t, kind: "thread" as const };
          }
        }
      }
    }

    for (const ch of meta.sidebar.orphans) {
      if (ch.id === roomId) return { ...ch, kind: "channel" as const };
      if (ch.activeThreads) {
        for (const t of ch.activeThreads) {
          if (t.id === roomId) return { ...t, kind: "thread" as const };
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
  const roomKind = $derived(
    sidebarRoomInfo?.kind ?? roomQuery.data?.kind,
  );
  const roomCanWrite = $derived(
    sidebarRoomInfo?.canWrite ?? roomQuery.data?.canWrite,
  );

  // Push room info to NavbarSpaceInfo — reactive so it updates when sidebar cache loads
  $effect(() => {
    const name = roomName;
    const kind = roomKind;
    untrack(() => {
      setCurrentRoom({
        id: roomId,
        name,
        kind: kind ?? "channel",
      });
    });
  });

  // ── Tab state ─────────────────────────────────────────────────────────────
  const channelTabList = ["Chat", "Threads"] as const;
  let channelActiveTab = $state<(typeof channelTabList)[number]>(
    spaceNavigation.get(spaceId)?.viewMode === "threads" ? "Threads" : "Chat",
  );

  // Re-sync from stored state when spaceId changes (component reuse across
  // spaces — SvelteKit reuses the same page component for the same route
  // pattern, so $state() only initializes once).
  $effect(() => {
    const sid = spaceId;
    untrack(() => {
      const stored = spaceNavigation.get(sid)?.viewMode;
      channelActiveTab = stored === "threads" ? "Threads" : "Chat";
    });
  });

  // Sync tab state from URL hash — clicking a toggle tab navigates to the hash,
  // which gives the user working browser back/forward between views.
  // Only reacts when a hash is present; on initial load with no hash the
  // stored view mode (or default "Chat") is preserved.
  $effect(() => {
    if (page.url.hash === "#chat") {
      channelActiveTab = "Chat";
    } else if (page.url.hash === "#threads") {
      channelActiveTab = "Threads";
    }
  });

  // Persist the active tab as a shared view mode ("chat" / "threads") so the
  // space index page can pick it up and vice versa.
  $effect(() => {
    spaceNavigation.set(spaceId, {
      destination: { kind: "room", id: roomId },
      viewMode: channelActiveTab === "Threads" ? "threads" : "chat",
    });
  });

  // Track when we're actively switching tabs to avoid auto-focusing input
  let isSwitchingTab = $state(false);
  let prevActiveTab = $state(channelActiveTab);

  $effect(() => {
    if (prevActiveTab !== channelActiveTab) {
      isSwitchingTab = true;
      // Reset the switching flag after a short delay
      setTimeout(() => {
        isSwitchingTab = false;
      }, 100);
      prevActiveTab = channelActiveTab;
    }
  });

  // Only show chat input area in chat view and when not a thread
  let showChatInput = $derived(roomKind === "channel" && channelActiveTab === "Chat");
</script>

{#snippet roomNavbar()}
  <div class="flex items-center gap-2 px-2 min-w-0 grow">
    {#if roomUnreadCount > 0}
      <span class="text-xs bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400 px-2 py-0.5 rounded-full">
        {roomUnreadCount} unread
      </span>
    {/if}

    {#if roomKind === "channel"}
      <span class="grow sm:hidden"></span>
      <div
        class="sm:absolute sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2"
      >
        <ToggleTabs
          items={channelTabList.map((x) => ({
            name: x,
            href: `#${x.toLowerCase()}`,
          }))}
          active={channelActiveTab}
        />
      </div>
    {/if}
  </div>
{/snippet}

<div class="h-full flex flex-col bg-white dark:bg-base-950">
  {#if roomKind === "channel"}
    <!-- Both ChatArea and ChannelBoardView stay mounted for smooth tab switching -->
    <div class="relative flex-1 min-h-0">
      <!-- Chat view - always rendered but visibility toggled -->
      <div class="absolute inset-0 flex flex-col" class:hidden={channelActiveTab !== "Chat"}>
        <ChatArea {spaceId} {roomId} />
      </div>

      <!-- Threads view - always rendered but visibility toggled -->
      <div class="absolute inset-0" class:hidden={channelActiveTab !== "Threads"}>
        <ChannelBoardView />
      </div>
    </div>

    <!-- Chat input area - only shown in chat view -->
    {#if showChatInput}
      <ChatInputArea {spaceId} {roomId} canWrite={roomCanWrite} autoFocus={!isSwitchingTab} />
    {/if}
  {:else}
    <!-- Thread rooms only have chat view -->
    <ChatArea {spaceId} {roomId} />
    <ChatInputArea {spaceId} {roomId} canWrite={roomCanWrite} />
  {/if}
</div>
