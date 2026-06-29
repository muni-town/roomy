<script lang="ts">
  import { onMount } from "svelte";
  import { currentSpaceState } from "./current-space.svelte";
  import { currentRoomState, setCurrentRoom } from "./current-room.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { IconHashtag, IconHome, IconThread } from "@roomy/design/icons";
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
    <span class="sm:hidden shrink-0">
      <SpaceAvatar
        src={resolveBlobUrl(currentSpace.avatar)}
        id={currentSpace.id}
        name={currentSpace.name ?? undefined}
        size={24}
      />
    </span>
    {#if currentRoom}
      <span class="text-base-300 dark:text-base-700 shrink-0 sm:hidden">/</span>
      {#if currentRoom.kind === "thread"}
        <IconThread class="size-4 shrink-0 text-base-500" />
      {:else}
        <IconHashtag class="size-4 shrink-0 text-base-500" />
      {/if}
      <span
        class="text-sm font-medium text-base-700 dark:text-base-300 truncate"
      >
        {currentRoom.name}
      </span>
    {:else}
      <span class="text-base-300 dark:text-base-700 shrink-0 sm:hidden">/</span>
      <IconHome class="size-4 shrink-0 text-base-500" />
      <span
        class="text-sm font-medium text-base-700 dark:text-base-300 truncate"
      >
        Index
      </span>
    {/if}
  </div>
{/if}