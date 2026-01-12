<script lang="ts">
  import { page } from "$app/state";
  import type { Ulid } from "$lib/schema";
  import { navigateSync } from "$lib/utils.svelte";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { Button } from "@fuxui/base";
  import IconCustomThread from "~icons/custom/thread";

  let {
    roomId = $bindable(),
  }: {
    roomId: Ulid;
  } = $props();

  $effect(() => {
    console.log("linkedRooms", {
      roomId,
      linkedRooms,
      spaceId: page.params.space,
    });
  });

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
  });
</script>

{#if linkedRooms && linkedRooms.length}
  <div
    class="flex flex-col items-start justify-between w-full min-w-0 group pl-3"
  >
    {#each linkedRooms as room}
      <div class="inline-flex w-full items-start justify-between min-w-0">
        <div class="max-h-4 overflow-visible">
          <IconCustomThread
            class="shrink-0 stroke-[0.6] stroke-base-500 h-[1.85rem] -mt-2 ml-[2px] -mr-[2px]"
          />
        </div>
        <Button
          href={navigateSync({
            space: page.params.space!,
            object: room.id,
          })}
          variant="ghost"
          class="w-full justify-start min-w-0 px-1 rounded-sm py-1 text-base-600"
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
