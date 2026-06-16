<script lang="ts">
  import { ScrollArea } from "@foxui/core";
  import BoardViewItem from "./BoardViewItem.svelte";
  import type { ThreadInfo } from "./types";

  const {
    threads,
    emptyMessage = "No items",
    hrefFor,
  }: {
    threads: ThreadInfo[];
    emptyMessage?: string;
    /** Build the href for a given thread row. */
    hrefFor: (thread: ThreadInfo) => string;
  } = $props();
</script>

{#if threads.length}
  <ScrollArea class="h-full pb-4 lg:max-w-[80%] w-full self-center">
    {#each threads as thread, i}
      <div class="mt-4">
        <BoardViewItem {thread} href={hrefFor(thread)} />
      </div>
      {#if i < threads.length - 1}
        <hr class="border-base-200 dark:border-base-800" />
      {/if}
    {/each}
  </ScrollArea>
{:else}
  <div class="h-full w-full flex items-center justify-center">
    <div class="p-2">{emptyMessage}</div>
  </div>
{/if}
