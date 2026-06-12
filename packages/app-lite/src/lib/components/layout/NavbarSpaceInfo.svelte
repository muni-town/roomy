<script lang="ts">
  import { onMount } from "svelte";
  import { currentSpaceState } from "./current-space.svelte";
  import { currentRoomState, setCurrentRoom } from "./current-room.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { IconHashtag, IconThread } from "@roomy/design/icons";
  import { resolveBlobUrl } from "$lib/utils";

  const currentSpace = $derived(currentSpaceState.value);
  const currentRoom = $derived(currentRoomState.value);

  onMount(() => {
    return () => setCurrentRoom(null);
  });
</script>

{#if currentSpace}
  <div class="flex items-center gap-2 ml-2 sm:ml-0 min-w-0">
    <SpaceAvatar
      src={resolveBlobUrl(currentSpace.avatar)}
      id={currentSpace.id}
      name={currentSpace.name ?? undefined}
      size={24}
    />
    {#if currentRoom}
      <span class="text-base-300 dark:text-base-700 shrink-0">/</span>
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
      <span
        class="text-sm font-medium text-base-700 dark:text-base-300 truncate max-w-40"
      >
        {currentSpace.name || "Unnamed"}
      </span>
    {/if}
  </div>
{/if}