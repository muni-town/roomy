<script lang="ts">
  import {
    AllThreadsComponent,
    co,
    CoFeed,
    getComponent,
    RoomyEntity,
    SubThreadsComponent,
    ThreadComponent,
  } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import { ScrollArea } from "@fuxui/base";
  import BoardViewItem from "$lib/components/content/thread/BoardViewItem.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SidebarMain.svelte";
  import { page } from "$app/state";
  import { untrack } from "svelte";

  let space = $derived(
    new CoState(RoomyEntity, page.params.space, {
      resolve: {
        components: true,
      },
    }),
  );

  let subthreadEnts = $derived(
    new CoState(
      SubThreadsComponent,
      space?.current?.components?.[AllThreadsComponent.id],
      {
        resolve: {
          $each: {
            components: {
              $each: true,
              $onError: null,
            },
          },
          $onError: null,
        },
      },
    ),
  );

  function timelineTimestamp(t?: CoFeed<string>): number {
    return (
      Object.values(t?.perSession || {})
        .map((x) => x.madeAt)
        .sort((a, b) => b.getTime() - a.getTime())[0]
        ?.getTime() || 0
    );
  }

  let sortedSubthreads = $state.raw([]);
  $effect(() => {
    const subthreads = Object.values(subthreadEnts.current?.perAccount || {})
      .map((x) => [...x.all].map((x) => x.value))
      .flat()
      .filter((x) => x && !x?.softDeleted) as co.loaded<typeof RoomyEntity>[];
    untrack(async () => {
      const resolved = await Promise.all(
        subthreads.map(async (ent) => {
          const thread = await getComponent(ent, ThreadComponent, {
            resolve: { timeline: true },
          });
          const timestamp = timelineTimestamp(thread?.timeline as any);

          return { ent, timestamp };
        }),
      );

      sortedSubthreads = resolved
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((x) => x.ent) as any;
    });
  });
</script>

<MainLayout>
  {#snippet sidebar()}
    <SidebarMain />
  {/snippet}

  {#snippet navbar()}
    <div class="ml-2 font-bold text-center w-full">All Threads</div>
  {/snippet}

  <ScrollArea class="h-full px-2 pb-4">
    {#if subthreadEnts.current}
      <ScrollArea class="h-full px-2 pb-4">
        {#each sortedSubthreads as subthread}
          {#if subthread}
            <div class="mt-4">
              <BoardViewItem thread={subthread} />
            </div>
          {/if}
        {/each}
      </ScrollArea>
    {:else}
      No threads in this Channel.
    {/if}
  </ScrollArea>
</MainLayout>
