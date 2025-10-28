<script lang="ts">
  import BoardViewItem from "./BoardViewItem.svelte";
  import { ScrollArea } from "@fuxui/base";
  import type { ThreadInfo } from "./types";

  const {
    threads,
    emptyMessage = "No items",
  }: { threads: ThreadInfo[]; emptyMessage?: string } = $props();

  console.log("threads", threads);
</script>

{#if threads.length}
  <ScrollArea class="h-full px-4 pb-4 lg:max-w-[80%] w-full self-center">
    {#each threads as thread}
      <div class="mt-4">
        <BoardViewItem {thread} />
      </div>
    {/each}
  </ScrollArea>
{:else}
  <div class="h-full w-full flex items-center justify-center">
    <div class="p-2">{emptyMessage}</div>
  </div>
{/if}
