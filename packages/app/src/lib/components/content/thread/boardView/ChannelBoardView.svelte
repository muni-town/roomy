<script lang="ts">
  import { page } from "$app/state";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { current } from "$lib/queries";
  import { sql } from "$lib/utils/sqlTemplate";
  import BoardView from "./BoardView.svelte";
  import type { ThreadInfo } from "./types";
  import { Ulid } from "@roomy/sdk";

  let { emptyMessage }: { objectType?: string; emptyMessage?: string } =
    $props();

  const spaceId = current.joinedSpace?.id;

  const threadsList = new LiveQuery<ThreadInfo>(
    () =>
      sql`
        select json_object(
          'id', id, 
          'name', name,
          'activity', json(activity)
        ) as json
        from (
          select
            r.entity as id,
            i.name as name,
            ci.name as channel,
            (
              select json_object(
                'members', json_group_array(json_object(
                  'avatar', avatar,
                  'name', author
                )),
                'latestTimestamp', max(timestamp)
              ) from (
                select
                  coalesce(author_override_info.avatar, author_info.avatar) as avatar,
                  coalesce(author_override_info.name, author_info.name) as author,
                  coalesce(override.timestamp, ulid_timestamp(me.id)) as timestamp
                from comp_content mc
                  join entities me on me.id = mc.entity
                  join edges author_edge on author_edge.head = me.id and author_edge.label = 'author'
                  join comp_info author_info on author_info.entity = author_edge.tail
                  left join comp_override_meta override on override.entity = me.id
                  left join comp_info author_override_info on author_override_info.entity = override.author
                where me.room = e.id
                group by author
                order by me.id desc
                limit 5
              )
            ) as activity
          from comp_room r
            join comp_info i on i.entity = r.entity
            join entities e on e.id = r.entity
            join edges pe on pe.tail = r.entity and pe.label = 'link'
            join comp_info ci on ci.entity = pe.head
          where
            e.stream_id = ${spaceId}
              and
            pe.head = ${page.params.object}
              and
            (r.label = 'space.roomy.thread' or r.label = 'space.roomy.page')
        )
        order by activity ->> 'latestTimestamp' desc
      `,
    (row) => JSON.parse(row.json),
  );
</script>

{#if threadsList.result || threadsList.error}
  <BoardView
    threads={threadsList.result || []}
    {emptyMessage}
    parent={page.params.object as Ulid}
  />
{/if}
