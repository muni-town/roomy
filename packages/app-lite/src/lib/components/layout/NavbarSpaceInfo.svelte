<script lang="ts">
  import { onMount } from "svelte";
  import { currentSpaceState } from "./current-space.svelte";
  import { currentRoomState, setCurrentRoom } from "./current-room.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { IconHashtag, IconHome, IconNeedleThread, IconChevronRight, IconEllipsisHorizontal } from "@roomy/design/icons";
  import { resolveBlobUrl } from "$lib/utils";

  const currentSpace = $derived(currentSpaceState.value);
  const currentRoom = $derived(currentRoomState.value);

  onMount(() => {
    return () => setCurrentRoom(null);
  });
</script>

{#if currentSpace}
  <div class="flex items-center gap-2 ml-4 sm:ml-2 min-w-0">
    <!-- Space context (avatar + name): mobile-only. On desktop the sidebar
         already shows the space header, so it's redundant here. -->
    <a href="/{currentSpace.id}" class="sm:hidden shrink-0">
      <SpaceAvatar
        src={resolveBlobUrl(currentSpace.avatar)}
        id={currentSpace.id}
        name={currentSpace.name ?? undefined}
        size={24}
      />
    </a>
    {#if currentRoom}
      {#if currentRoom.kind === "thread"}
        <!-- Thread breadcrumb: parent channel link + thread name -->
        {#if currentRoom.parentChannelId}
          <!-- Mobile: ellipsis + caret -->
          <a href="/{currentSpace.id}/{currentRoom.parentChannelId}" class="sm:hidden flex items-center gap-1 text-base-500 hover:text-base-700 dark:hover:text-base-300">
            <IconEllipsisHorizontal class="size-4 shrink-0" />
            <IconChevronRight class="size-3 shrink-0" />
          </a>
          <!-- Desktop: hashtag + parent channel name -->
          <a href="/{currentSpace.id}/{currentRoom.parentChannelId}" class="hidden sm:flex items-center gap-1 text-base-500 hover:text-base-700 dark:hover:text-base-300 min-w-0">
            <IconHashtag class="size-4 shrink-0" />
            <span class="text-sm truncate">{currentRoom.parentChannelName}</span>
            <IconChevronRight class="size-3 shrink-0" />
          </a>
        {/if}
        <IconNeedleThread class="size-4 shrink-0 text-base-500" />
      {:else}
        <IconHashtag class="size-4 shrink-0 text-base-500" />
      {/if}
      <span
        class="text-sm font-medium text-base-700 dark:text-base-300 truncate"
      >
        {currentRoom.name}
      </span>
    {:else}
      <IconHome class="size-4 shrink-0 text-base-500 ml-0.5 -mt-0.5" />
      <span
        class="text-sm font-medium text-base-700 dark:text-base-300 truncate"
      >
        Index
      </span>
    {/if}
  </div>
{/if}