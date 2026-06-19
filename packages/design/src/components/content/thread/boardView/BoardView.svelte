<script lang="ts">
  import { ScrollArea } from "@foxui/core";
  import BoardViewItem from "./BoardViewItem.svelte";
  import type { ThreadInfo } from "./types";

  const {
    threads,
    emptyMessage = "No items",
    hrefFor,
    onAvatarClick,
    compact = false,
  }: {
    threads: ThreadInfo[];
    emptyMessage?: string;
    /** Build the href for a given thread row. */
    hrefFor: (thread: ThreadInfo) => string;
    onAvatarClick?: (did: string) => void;
    compact?: boolean;
  } = $props();
</script>

{#if threads.length}
  <ScrollArea class="h-full pb-4 w-full">
    {#each threads as thread, i}
      <div class={compact ? '' : 'mt-4'}>
        <BoardViewItem {thread} href={hrefFor(thread)} {onAvatarClick} {compact} />
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
