<script lang="ts">
  import {
    AllThreadsComponent,
    RoomyEntity,
    SubThreadsComponent,
  } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import { ScrollArea } from "@fuxui/base";
  import BoardViewItem from "$lib/components/content/thread/BoardViewItem.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SidebarMain.svelte";
  import { page } from "$app/state";

  let space = $derived(
    new CoState(RoomyEntity, page.params.space, {
      resolve: {
        components: true,
      },
    }),
  );

  let subthreads = $derived(
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
</script>

<MainLayout>
  {#snippet sidebar()}
    <SidebarMain />
  {/snippet}

  {#snippet navbar()}
    <div class="ml-2 font-bold text-center w-full">All Threads</div>
  {/snippet}

  <ScrollArea class="h-full px-2 pb-4">
    {#if subthreads.current}
      <ScrollArea class="h-full px-2 pb-4">
        {#each Object.values(subthreads.current.perAccount)
          .map((x) => [...x.all].map((x) => x.value))
          .flat() as subthread}
          {#if subthread && subthread.softDeleted == false}
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
