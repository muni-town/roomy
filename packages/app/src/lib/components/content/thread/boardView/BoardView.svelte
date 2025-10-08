<script lang="ts">
  import { page } from "$app/state";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { id } from "$lib/workers/encoding";
  import BoardViewItem from "./BoardViewItem.svelte";
  import { ScrollArea } from "@fuxui/base";
  import type { ThreadInfo } from "./types";
  import { fade } from "svelte/transition";

  const query = new LiveQuery<ThreadInfo>(
    () => sql`
      select json_object(
        'id', id(r.entity),
        'name', name,
        'members', (
          select json_array()
        )
      ) as json
      from comp_room r
        join comp_info i on i.entity = r.entity
        join entities e on e.id = r.entity
      where
        e.parent = ${page.params.object && id(page.params.object)}
          and
        r.label = 'thread'
    `,
    (row) => JSON.parse(row.json),
  );
</script>

{#if query.result || query.error}
  <div transition:fade={{duration: 150}}>
    {#if query.result?.length}
      <ScrollArea class="h-full px-2 pb-4">
        {#each query.result || [] as thread}
          <div class="mt-4">
            <BoardViewItem {thread} />
          </div>
        {/each}
      </ScrollArea>
    {:else}
      No threads in this Channel.
    {/if}
  </div>
{/if}
