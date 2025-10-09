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
          e.stream_id = ${page.params.space ? id(page.params.space) : null}
            and
          r.label = 'thread'
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
        <span>{current.space?.name}</span>
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
