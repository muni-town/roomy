<script lang="ts">
  import { page } from "$app/state";
  import { useTopicSubscription } from "@roomy-space/sdk/svelte";
  import type { Topic } from "@roomy-space/sdk/svelte";
  import { IconHashtag } from "@roomy/design/icons";
  import { sync_ } from "$lib/sync.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { createRoomMetadataQuery } from "$lib/queries/room-metadata";
  import { updateSeen } from "$lib/mutations/update-seen";
  import ChatArea from "$lib/components/chat/ChatArea.svelte";
  import ChatInputArea from "$lib/components/chat/ChatInputArea.svelte";

  const spaceId = $derived(page.params.space!);
  const roomId = $derived(page.params.room!);

  useTopicSubscription(
    () => sync_.ctx?.topicManager ?? null,
    () => [{ kind: "room", id: roomId } satisfies Topic],
  );

  $effect(() => {
    sync_.setActiveRoom(roomId);
    updateSeen(roomId).catch(() => {});
    return () => {
      if (sync_.activeRoomId === roomId) sync_.setActiveRoom(null);
    };
  });

  $effect(() => {
    setNavbar(roomNavbar);
    return () => setNavbar(undefined);
  });

  const roomQuery = createRoomMetadataQuery(() => roomId);
</script>

{#snippet roomNavbar()}
  <div class="flex items-center gap-2 px-2 min-w-0 grow">
    <IconHashtag class="size-5 shrink-0 text-base-500" />
    <h2 class="font-semibold truncate text-base-900 dark:text-base-100">
      {roomQuery.data?.name ?? "Channel"}
    </h2>
    {#if roomQuery.data && roomQuery.data.unreadCount > 0}
      <span class="text-xs bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400 px-2 py-0.5 rounded-full">
        {roomQuery.data.unreadCount} unread
      </span>
    {/if}
  </div>
{/snippet}

<div class="h-full flex flex-col bg-white dark:bg-base-950">
  <ChatArea {spaceId} {roomId} />
  <ChatInputArea {spaceId} {roomId} canWrite={roomQuery.data?.canWrite ?? false} />
</div>
