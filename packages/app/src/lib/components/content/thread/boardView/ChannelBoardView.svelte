<script lang="ts">
  import { page } from "$app/state";
  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { peer } from "$lib/workers";
  import { sql } from "$lib/utils/sqlTemplate";

  import BoardView from "./BoardView.svelte";
  import type { ThreadInfo } from "./types";
  import { StreamIndex, Ulid } from "@roomy/sdk";

  let { emptyMessage }: { objectType?: string; emptyMessage?: string } =
    $props();

  const spaceId = app.joinedSpace?.id;

  const threadsList = new LiveQuery<ThreadInfo>(
    () =>
      sql`
        select json_object(
          'id', id,
          'name', name,
          'channel', channel,
          'channelName', channelName,
          'canonicalParent', canonicalParent,
          'activity', json(activity),
          'kind', label
        ) as json
        from (
          select
            r.entity as id,
            i.name as name,
            ci.name as channel,
            ci.name as channelName,
            pe.head as canonicalParent,
            r.label as label,
            (
              select json_object(
                'members', json_group_array(json_object(
                  'avatar', avatar,
                  'name', author
                )),
                'latestTimestamp', max(timestamp)
              ) from (
                select
                  author_info.avatar as avatar,
                  author_info.name as author,
                  mc.timestamp as timestamp,
                  row_number() over (
                    partition by author_edge.tail
                    order by me.id desc
                  ) as row_num
                from comp_content mc
                  join entities me on me.id = mc.entity
                  join edges author_edge on author_edge.head = me.id and author_edge.label = 'author'
                  join comp_info author_info on author_info.entity = author_edge.tail
                where me.room = e.id
              ) where row_num = 1 limit 3
            ) as activity
          from comp_room r
            join comp_info i on i.entity = r.entity
            join entities e on e.id = r.entity
            left join edges pe on pe.tail = r.entity and pe.label = 'link'
            left join comp_info ci on ci.entity = pe.head
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
    {
      description:
        "List of threads in a channel with parent, latest activity, other metadata",
      origin: "ChannelBoardView.svelte",
    },
  );

  $effect(() => {
    if (!spaceId || !page.params.object) return;
    // Fetch link events posted in this channel
    peer.fetchLinks(
      spaceId,
      0 as StreamIndex,
      1000,
      page.params.object as Ulid,
    );
  });
</script>

{#if threadsList.result || threadsList.error}
  <BoardView
    threads={threadsList.result || []}
    {emptyMessage}
    parent={page.params.object as Ulid}
  />
{/if}
