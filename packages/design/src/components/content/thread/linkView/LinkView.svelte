<script lang="ts">
  /**
   * LinkView — full-width, newest-first list of every link shared in a room
   * (or space). The link analogue of {@link BoardView}: same shell contract,
   * same container-query breakpoints, same intersection-observer pagination.
   */
  import { ScrollArea } from "@foxui/core";
  import LinkViewItem from "./LinkViewItem.svelte";
  import type { LinkInfo } from "./types";

  let {
    links,
    emptyMessage = "No links shared yet",
    loadMore,
    hasMore = false,
  }: {
    links: LinkInfo[];
    emptyMessage?: string;
    /** Called when the user scrolls near the end of the list. */
    loadMore?: () => void;
    /** Whether there are more pages to load. */
    hasMore?: boolean;
  } = $props();

  let sentinel: HTMLElement | undefined = $state();

  $effect(() => {
    const el = sentinel;
    const cb = loadMore;
    if (!el || !cb) return;

    let fetching = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !fetching) {
          fetching = true;
          cb();
          timer = setTimeout(() => {
            fetching = false;
          }, 500);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  });
</script>

{#if links.length}
  <ScrollArea class="h-full pb-4 w-full @container">
    {#each links as link (link.url)}
      <LinkViewItem {link} />
    {/each}
    {#if hasMore}
      <div bind:this={sentinel} class="flex items-center justify-center py-4">
        <div class="text-sm text-base-400">Loading more…</div>
      </div>
    {/if}
  </ScrollArea>
{:else}
  <div class="h-full w-full flex items-center justify-center">
    <div class="p-2">{emptyMessage}</div>
  </div>
{/if}
