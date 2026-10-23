<script lang="ts">
  /**
   * BoardView — the space/channel index: one row per room, ordered by latest
   * activity, paginated by an intersection observer.
   *
   * The whole surface belongs to this shell — the first-load state, the error
   * state, the empty state and the list — so a caller contributes data and
   * nothing else.
   */
  import { ScrollArea } from "@foxui/core";
  import BoardViewItem from "./BoardViewItem.svelte";
  import ErrorMessage from "../../../helper/ErrorMessage.svelte";
  import type { ThreadInfo } from "./types";

  let {
    threads,
    emptyMessage = "No items",
    hrefFor,
    hideChannel = false,
    loadMore,
    hasMore = false,
    loading = false,
    loadingMessage = "Loading…",
    error,
  }: {
    threads: ThreadInfo[];
    emptyMessage?: string;
    /** Build the href for a given thread row. */
    hrefFor: (thread: ThreadInfo) => string;
    /** Hide the parent channel column (e.g. when viewing a single channel). */
    hideChannel?: boolean;
    /** Called when the user scrolls near the end of the list. */
    loadMore?: () => void;
    /** Whether there are more pages to load. */
    hasMore?: boolean;
    /** First page is still in flight — renders the loading line. */
    loading?: boolean;
    loadingMessage?: string;
    /** The fetch failed; rendered in place of the whole surface. */
    error?: string;
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
          timer = setTimeout(() => { fetching = false; }, 500);
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

{#if error}
  <ErrorMessage message={error} class="h-full w-full justify-center" />
{:else if loading && !threads.length}
  <div class="h-full w-full flex items-center justify-center">
    <div class="text-sm text-base-400 p-2">{loadingMessage}</div>
  </div>
{:else if threads.length}
  <ScrollArea class="h-full pb-4 w-full @container">
    {#each threads as thread}
      <BoardViewItem {thread} href={hrefFor(thread)} {hideChannel} />
    {/each}
    {#if hasMore}
      <div
        bind:this={sentinel}
        class="flex items-center justify-center py-4"
      >
        <div class="text-sm text-base-400">Loading more…</div>
      </div>
    {/if}
  </ScrollArea>
{:else}
  <div class="h-full w-full flex items-center justify-center">
    <div class="p-2">{emptyMessage}</div>
  </div>
{/if}
