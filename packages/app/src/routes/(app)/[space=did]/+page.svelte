<script lang="ts">
  import { fade } from "svelte/transition";

  import { current, sidebar as sidebarQuery } from "$lib/queries";
  import { backendStatus } from "$lib/workers";
  import { onNavigate } from "$app/navigation";

  import { LiveQuery } from "$lib/utils/liveQuery.svelte";
  import { sql } from "$lib/utils/sqlTemplate";

  import BoardView from "$lib/components/content/thread/boardView/BoardView.svelte";
  import LoadingLine from "$lib/components/helper/LoadingLine.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import JoinSpaceModal from "$lib/components/modals/JoinSpaceModal.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";

  import type { ThreadInfo } from "$lib/components/content/thread/boardView/types";
  import Error from "$lib/components/modals/Error.svelte";
  import { flags } from "$lib/flags";
  import { navigate } from "$lib/utils.svelte";

  const spaceId = $derived(current.joinedSpace?.id);

  $effect(() => {
    if (flags.threadsList || !current.joinedSpace) return;
    const firstCategory = sidebarQuery.result?.[0];
    if (firstCategory?.type === "space.roomy.category") {
      const firstChild = firstCategory.children?.[0]?.id;
      if (firstChild)
        navigate({
          space: current.joinedSpace.id,
          channel: firstChild,
        });
    }
  });

  let threadsQuery = new LiveQuery<ThreadInfo>(
    () => {
      return sql`
        select json_object(
          'id', id, 
          'name', name,
          'channel', channel,
          'activity', json(activity),
          'kind', label
        ) as json
        from (
          select
            r.entity as id,
            i.name as name,
            null as channel,
            r.label as label,
            (
              select json_object(
                'members', json_group_array(json_object(
                  'avatar', avatar,
                  'name', author,
                  'id', author_id
                )),
                'latestTimestamp', max(timestamp),
                'test', json_group_array(id)
              ) from (
                select
                  ulid_timestamp(edits.edit_id) as timestamp,
                  edits.edit_id as id,
                  author_info.name as author,
                  edits.user_id as author_id,
                  author_info.avatar as avatar,
                  row_number() over (
                    partition by user_id
                    order by edit_id desc
                  ) as row_num
                from comp_page_edits edits
                  join entities me on me.id = edits.entity
                  left join comp_info author_info on author_info.entity = edits.user_id
                where edits.entity = e.id
              ) where row_num = 1 limit 3
            ) as activity
          from comp_room r
            join comp_info i on i.entity = r.entity
            join entities e on e.id = r.entity
          where
            e.stream_id = ${spaceId}
              and
            r.label = 'page'

            union

          select
            r.entity as id,
            i.name as name,
            ci.name as channel,
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
                  case when override.entity is not null then null else coalesce(author_override_info.avatar, author_info.avatar) end as avatar,
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
                limit 3
              )
            ) as activity
          from comp_room r
            join comp_info i on i.entity = r.entity
            join entities e on e.id = r.entity
            join comp_info ci on ci.entity = e.room
          where
            e.stream_id = ${spaceId}
              and
            r.label = 'thread'
        )
        order by activity ->> 'latestTimestamp' desc
      `;
    },
    (row) => JSON.parse(row.json),
  );

  const threads = $state<{ list: ThreadInfo[] }>({ list: [] });

  $effect(() => {
    threads.list = threadsQuery.result || [];
  });

  const roomLoading = $derived(
    current.space.status === "loading" ||
      threadsQuery.current.status === "loading",
  );

  onNavigate(() => {
    threads.list = [];
  });
</script>

{#snippet sidebar()}
  <SidebarMain />
{/snippet}

{#snippet navbar()}
  <div class="relative w-full">
    <div class="flex flex-col items-center justify-between w-full px-2">
      <h2
        class="w-full py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        <div class="ml-2 font-bold grow text-center text-lg">Index</div>

        {#if current.joinedSpace?.id && backendStatus.authState?.state === "loading"}
          <div class="dark:!text-base-400 !text-base-600">
            Downloading Entire Space...
          </div>
        {/if}
      </h2>
    </div>

    {#if current.joinedSpace?.id && backendStatus.authState?.state === "loading"}
      <LoadingLine />
    {/if}
  </div>
{/snippet}

{#if current.space.status === "error"}
  <MainLayout>
    <Error message={current.space.message} />
  </MainLayout>
{:else if current.space.status === "invited"}
  <MainLayout>
    <JoinSpaceModal />
  </MainLayout>
{:else}
  <MainLayout {sidebar} {navbar}>
    {#if roomLoading}
      <!-- TODO loading spinner -->
      <div class="h-full w-full flex">
        <div class="m-auto">Loading...</div>
      </div>
    {:else if threads}
      <div
        transition:fade={{ duration: 200 }}
        class="flex flex-col justify-center h-full w-full"
      >
        <BoardView threads={threads.list} emptyMessage="No threads found." />
      </div>
    {:else if threadsQuery.error}
      <Error message={threadsQuery.error} />
    {/if}
  </MainLayout>
{/if}
