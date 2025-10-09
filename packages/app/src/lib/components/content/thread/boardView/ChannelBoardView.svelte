<script lang="ts">
  import { page } from "$app/state";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { id } from "$lib/workers/encoding";
  import BoardView from "./BoardView.svelte";
  import type { ThreadInfo } from "./types";

  const threadsList = new LiveQuery<ThreadInfo>(
    () =>
      sql`
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

{#if threadsList.result || threadsList.error}
  <BoardView threads={threadsList.result || []} />
{/if}
