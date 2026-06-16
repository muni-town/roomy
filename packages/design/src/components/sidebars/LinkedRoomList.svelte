<script lang="ts" module>
  export type LinkedRoom = {
    id: string;
    name: string;
    unreadCount: number;
    lastRead: number;
  };
</script>

<script lang="ts">
  import Button from "../ui/button/Button.svelte";
  import { IconThread } from "../../icons/index";

  let {
    rooms,
    currentRoomId,
    hrefFor,
  }: {
    rooms: LinkedRoom[];
    /** The ID of the currently-active room (drives data-current). */
    currentRoomId?: string;
    /** Build the link href for a given room id. */
    hrefFor: (roomId: string) => string;
  } = $props();
</script>

{#if rooms.length}
  <div
    class="flex flex-col items-start justify-between w-full min-w-0 group pl-3"
  >
    {#each rooms as room}
      {@const isActive = room.id === currentRoomId}
      {@const hasUnread =
        room.lastRead > 0 &&
        room.unreadCount > 0 &&
        !isActive}
      <div class="inline-flex w-full items-start justify-between min-w-0">
        <div class="max-h-4 overflow-visible">
          <IconThread
            class={`shrink-0 stroke-[0.6] h-[1.85rem] -mt-2 ml-0.5 -mr-0.5 ${hasUnread || isActive ? "stroke-base-500" : "stroke-base-400 dark:stroke-base-500"}`}
          />
        </div>
        <Button
          href={hrefFor(room.id)}
          variant="ghost"
          class="justify-start min-w-0 w-full rounded-full p-0.75 pt-0.5 pl-2 text-base-600 hover:bg-transparent"
          data-current={room.id === currentRoomId}
        >
          <span
            class={`truncate whitespace-nowrap overflow-hidden min-w-0 ${hasUnread || isActive ? "font-semibold" : "font-normal"} ${!hasUnread && !isActive ? "text-base-500 dark:text-base-500" : ""}`}
            >{room.name}</span
          >
        </Button>
      </div>
    {/each}
  </div>
{/if}
