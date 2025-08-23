<script lang="ts">
  import { RoomyEntity, SubThreadsComponent } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import BoardViewItem from "./BoardViewItem.svelte";
  import { ScrollArea } from "@fuxui/base";

  let { objectId }: { objectId: string } = $props();

  let object = $derived(
    new CoState(RoomyEntity, objectId, {
      resolve: {
        components: true,
      },
    }),
  );

  let subthreads = $derived(
    new CoState(
      SubThreadsComponent,
      object?.current?.components?.[SubThreadsComponent.id],
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

{#if subthreads.current}
  <div
    class="sticky flex pt-3 text-lg border-b-2 border-solid px-6 shadow-md pb-2"
  >
    Thread Name

    <span class="grow"></span>

    <span class="mr-12">Members</span>
    <span class="pr-2">Last Activity</span>
  </div>
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
{/if}
