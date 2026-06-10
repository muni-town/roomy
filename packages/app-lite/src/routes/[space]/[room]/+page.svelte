<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { page } from "$app/state";
  import { useTopicSubscription } from "@roomy-space/sdk/svelte";
  import type { Topic } from "@roomy-space/sdk/svelte";
  import { IconHashtag, IconThread } from "@roomy/design/icons";
  import { sync_ } from "$lib/sync.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
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
    return () => setNavbar(undefined);
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

  // ── Tab state ─────────────────────────────────────────────────────────────
  const channelTabList = ["Chat", "Threads"] as const;
  let channelActiveTab = $state<(typeof channelTabList)[number]>("Chat");

  $effect(() => {
    if (page.url.hash == "#chat") {
      channelActiveTab = "Chat";
    } else if (page.url.hash == "#threads") {
      channelActiveTab = "Threads";
    } else {
      channelActiveTab = "Chat";
    }
  });
</script>

{#snippet roomNavbar()}
  <div class="flex items-center gap-2 px-2 min-w-0 grow">
    {#if roomKind === "thread"}
      <IconThread class="size-5 shrink-0 text-base-500" />
    {:else}
      <IconHashtag class="size-5 shrink-0 text-base-500" />
    {/if}
    <h2 class="font-semibold truncate text-base-900 dark:text-base-100">
      {roomName}
    </h2>
    {#if roomUnreadCount > 0}
      <span class="text-xs bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400 px-2 py-0.5 rounded-full">
        {roomUnreadCount} unread
      </span>
    {/if}

    {#if roomKind === "channel"}
      <span class="grow"></span>
      <ToggleTabs
        items={channelTabList.map((x) => ({
          name: x,
          href: `#${x.toLowerCase()}`,
        }))}
        active={channelActiveTab}
      />
    {/if}
  </div>
{/snippet}

<div class="h-full flex flex-col bg-white dark:bg-base-950">
  {#if channelActiveTab === "Chat"}
    <ChatArea {spaceId} {roomId} />
    <ChatInputArea {spaceId} {roomId} canWrite={roomCanWrite} />
  {:else}
    <ChannelBoardView />
  {/if}
</div>
