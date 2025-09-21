<script lang="ts">
  import BoardViewItem from "./BoardViewItem.svelte";
  import { ScrollArea } from "@fuxui/base";

  // let { objectId }: { objectId: string } = $props();

  // let object = $derived(
  //   new CoState(RoomyEntity, objectId, {
  //     resolve: {
  //       components: true,
  //     },
  //   }),
  // );

  // let subthreads = $derived(
  //   new CoState(
  //     SubThreadsComponent,
  //     object?.current?.components?.[SubThreadsComponent.id],
  //     {
  //       resolve: {
  //         $each: {
  //           components: {
  //             $each: true,
  //             $onError: null,
  //           },
  //         },
  //         $onError: null,
  //       },
  //     },
  //   ),
  // );
</script>

<!-- {#if subthreads.current}
  <ScrollArea class="h-full px-2 pb-4">
    {#each Object.values(subthreads.current.perAccount)
      .map((x) => [...x.all].map((x) => x.value))
      .flat() as subthread}
      {#if subthread}
        <div class="mt-4">
          <BoardViewItem thread={subthread} />
        </div>
      {/if}
    {/each}
  </ScrollArea>
{:else}
  No threads in this Channel.
{/if} -->
