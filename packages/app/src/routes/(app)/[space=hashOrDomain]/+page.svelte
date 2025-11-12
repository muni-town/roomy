<script lang="ts">
  import { onNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import BoardView from "$lib/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "$lib/components/content/thread/boardView/types";
  import LoadingLine from "$lib/components/helper/LoadingLine.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SpaceSidebar.svelte";
  import SpaceAvatar from "$lib/components/spaces/SpaceAvatar.svelte";
  import { LiveQuery } from "$lib/liveQuery.svelte";
  import { current } from "$lib/queries.svelte";
  import { sql } from "$lib/utils/sqlTemplate";
  import { backend, backendStatus } from "$lib/workers";
  import { id } from "$lib/workers/encoding";
  import { Box, Button, toast } from "@fuxui/base";
  import { fade } from "svelte/transition";
  import { ulid } from "ulidx";

  let inviteSpaceName = $derived(page.url.searchParams.get("name"));
  let inviteSpaceAvatar = $derived(page.url.searchParams.get("avatar"));

  async function joinSpace() {
    try {
      const spaceId = page.params.space?.includes(".")
        ? (await backend.resolveSpaceFromHandleOrDid(page.params.space))
            ?.spaceId
        : page.params.space;
      if (!spaceId || !backendStatus.personalStreamId) {
        toast.error("Could not join space. It's possible it does not exist.");
        return;
      }
      await backend.sendEvent(backendStatus.personalStreamId, {
        ulid: ulid(),
        parent: undefined,
        variant: {
          kind: "space.roomy.space.join.0",
          data: {
            spaceId,
          },
        },
      });
    } catch (e) {
      console.error(e);
      toast.error("Could not join space. It's possible it does not exist.");
    }
  }
  const threadsList = new LiveQuery<ThreadInfo>(
    () =>
      sql`
        select json_object(
          'id', id(id), 
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
                  'id', id(author_id)
                )),
                'latestTimestamp', max(timestamp),
                'test', json_group_array(id(id))
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
            e.stream_id = ${current.space?.id ? id(current.space.id) : null}
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
                limit 3
              )
            ) as activity
          from comp_room r
            join comp_info i on i.entity = r.entity
            join entities e on e.id = r.entity
            join comp_info ci on ci.entity = e.parent
          where
            e.stream_id = ${current.space?.id ? id(current.space.id) : null}
              and
            r.label = 'thread'
        )
        order by activity ->> 'latestTimestamp' desc
      `,
    (row) => JSON.parse(row.json),
  );

  onNavigate(() => (threadsList.result = undefined));
</script>

{#snippet sidebar()}
  <SidebarMain />
{/snippet}

<MainLayout sidebar={current.space ? (sidebar as any) : undefined}>
  {#snippet navbar()}
    <div class="relative w-full">
      <div class="flex flex-col items-center justify-between w-full px-2">
        <h2
          class="w-full py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
        >
          <div class="ml-2 font-bold grow text-center text-lg">Index</div>

          {#if current.space?.id && backendStatus.loadingSpaces}
            <div class="dark:!text-base-400 !text-base-600">
              Downloading Entire Space...
            </div>
          {/if}
        </h2>
      </div>

      {#if current.space?.id && backendStatus.loadingSpaces}
        <LoadingLine />
      {/if}
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
  {:else if threadsList.result}
    <div
      transition:fade={{ duration: 200 }}
      class="flex flex-col justify-center h-full w-full"
    >
      <BoardView threads={threadsList.result || []} />
    </div>
  {:else if threadsList.error}
    Error loading: {threadsList.error}
  {:else}
    <!-- TODO loading spinner -->
    <div class="h-full w-full flex">
      <div class="m-auto">Loading...</div>
    </div>
  {/if}
</MainLayout>
