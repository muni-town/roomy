<script lang="ts">
  import BoardViewItem from "./BoardViewItem.svelte";
  import { ScrollArea } from "@fuxui/base";
  import type { ThreadInfo } from "./types";

  const { threads }: { threads: ThreadInfo[] } = $props();
</script>

{#if threads.length}
  <ScrollArea class="h-full px-2 pb-4">
    {#each threads as thread}
      <div class="mt-4">
        <BoardViewItem {thread} />
      </div>
    {/each}
  </ScrollArea>
{:else}
  <div class="p-2">No threads in this Channel.</div>
{/if}
