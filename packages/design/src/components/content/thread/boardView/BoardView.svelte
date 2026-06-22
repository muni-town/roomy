<script lang="ts">
  import { ScrollArea } from "@foxui/core";
  import BoardViewItem from "./BoardViewItem.svelte";
  import type { ThreadInfo } from "./types";

  const {
    threads,
    emptyMessage = "No items",
    hrefFor,
    hideChannel = false,
  }: {
    threads: ThreadInfo[];
    emptyMessage?: string;
    /** Build the href for a given thread row. */
    hrefFor: (thread: ThreadInfo) => string;
    /** Hide the parent channel column (e.g. when viewing a single channel). */
    hideChannel?: boolean;
  } = $props();
</script>

{#if threads.length}
  <ScrollArea class="h-full px-4 pb-4 lg:max-w-[80%] w-full mx-auto">
    {#each threads as thread}
      <div class="mt-4">
        <BoardViewItem {thread} href={hrefFor(thread)} {hideChannel} />
      </div>
    {/each}
  </ScrollArea>
{:else}
  <div class="h-full w-full flex items-center justify-center">
    <div class="p-2">{emptyMessage}</div>
  </div>
{/if}
