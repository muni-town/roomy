<script lang="ts">
  import { page } from "$app/state";
  import type { Ulid } from "@roomy/sdk";
  import { navigateSync } from "$lib/utils.svelte";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { Button } from "@fuxui/base";
  import { IconThread } from "@roomy/design/icons";

  let {
    roomId = $bindable(),
  }: {
    roomId: Ulid;
  } = $props();

  let query = new LiveQuery<{ name: string; id: Ulid }>(
    () => sql`
      select
        ci.name, room.entity as id
        from entities parent_e
        join edges link on link.head = parent_e.id and link.label = 'link'
        join comp_room room on link.tail = room.entity 
        join comp_info ci on ci.entity = room.entity
        where parent_e.stream_id = ${page.params.space}
        and parent_e.id = ${roomId}
        limit 5
    `,
  );

  let linkedRooms = $derived.by(() => {
    if (!query.result) return null;
    return query.result;
    // idea to reorder to have the active room first
    // const activeRoom = query.result.find((r) => r.id === page.params.object);
    // const rooms = query.result.filter((r) => r.id !== page.params.object);
    // if (activeRoom) rooms.unshift(activeRoom);
    // return rooms;
  });
</script>

{#if linkedRooms && linkedRooms.length}
  <div
    class="flex flex-col items-start justify-between w-full min-w-0 group pl-3"
  >
    {#each linkedRooms as room}
      <div class="inline-flex w-full items-start justify-between min-w-0">
        <div class="max-h-4 overflow-visible">
          <IconThread
            class="shrink-0 stroke-[0.6] stroke-base-500 h-[1.85rem] -mt-2 ml-[2px] -mr-[2px]"
          />
        </div>
        <Button
          href={navigateSync({
            space: page.params.space!,
            object: room.id,
          }) +
            "?parent=" +
            (page.url.searchParams.get("parent") || page.params.object)}
          variant="ghost"
          class="justify-start min-w-0 w-full rounded-full p-1 pl-2 text-base-600 hover:bg-transparent"
          data-current={room.id === page.params.object}
        >
          <!-- {#if isSubthread}<IconTablerCornerDownRight />{:else}
        <IconHeroiconsHashtag class="shrink-0" />{/if} -->

          <span
            class="truncate whitespace-nowrap overflow-hidden min-w-0 font-normal"
            >{room.name}</span
          >
          <!-- {#if item.type === "space.roomy.page"}<div class="ml-auto">
          <IconHeroiconsDocument class="opacity-60 shrink" />
        </div>{/if} -->
        </Button>
      </div>
    {/each}
  </div>
{/if}
