<script lang="ts">
  import { page } from "$app/state";
  import BoardView from "$lib/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "$lib/components/content/thread/boardView/types";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { current } from "$lib/queries.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { backend, backendStatus } from "$lib/workers";
  import { id } from "$lib/workers/encoding";
  import { Box, Button } from "@fuxui/base";
  import { ulid } from "ulidx";

  let inviteSpaceName = $derived(page.url.searchParams.get("name"));
  let inviteSpaceAvatar = $derived(page.url.searchParams.get("avatar"));

  async function joinSpace() {
    if (!backendStatus.personalStreamId || !page.params.space) return;
    await backend.sendEvent(backendStatus.personalStreamId, {
      ulid: ulid(),
      parent: undefined,
      variant: {
        kind: "space.roomy.space.join.0",
        data: {
          spaceId: page.params.space,
        },
      },
    });
  }

  const threadsList = new LiveQuery<ThreadInfo>(
    () =>
      sql`
        select json_object(
          'id', id(id), 
          'name', name,
          'channel', channel,
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
                where me.parent = e.id
                group by author
                order by me.id desc
                limit 5
              )
            ) as activity
          from comp_room r
            join comp_info i on i.entity = r.entity
            join entities e on e.id = r.entity
            join comp_info ci on ci.entity = e.parent
          where
            e.stream_id = ${page.params.space ? id(page.params.space) : null}
              and
            r.label = 'thread'
        )
        order by activity ->> 'latestTimestamp' desc
      `,
    (row) => JSON.parse(row.json),
  );
</script>

{#snippet sidebar()}
  <SidebarMain />
{/snippet}

<MainLayout sidebar={current.space ? (sidebar as any) : undefined}>
  {#snippet navbar()}
    <div class="flex flex-col items-center justify-between w-full px-2">
      <h2
        class="text-lg font-bold w-full py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        <div class="ml-2 font-bold grow text-center">All Threads</div>
      </h2>
    </div>
  {/snippet}

  {#if !current.space}
    <div class="flex items-center justify-center h-full">
      <Box class="w-[20em] flex flex-col">
        <div class="mb-5 flex justify-center items-center gap-3">
          <SpaceAvatar
            imageUrl={inviteSpaceAvatar ?? ""}
            id={page.params.space}
            name={inviteSpaceName ?? ""}
            size={50}
          />
          {#if inviteSpaceName}
            <h1 class="font-bold text-xl">{inviteSpaceName}</h1>
          {/if}
        </div>
        <Button size="lg" onclick={joinSpace}>Join Space</Button>
      </Box>
    </div>
  {:else}
    <BoardView threads={threadsList.result || []} />
  {/if}
</MainLayout>
