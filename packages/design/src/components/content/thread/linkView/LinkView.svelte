<script lang="ts">
  /**
   * LinkView — responsive card grid of every link shared in a room (or space),
   * newest-first.
   *
   * The link analogue of {@link BoardView}: same shell contract
   * (`links` / `emptyMessage` / `loadMore` / `hasMore`) and the same
   * intersection-observer pagination, but the composition is a grid of
   * preview cards rather than a column of rows — a link index earns the
   * visuals its records already carry.
   *
   * Breakpoints are container queries, so the grid reflows with the view
   * width rather than the viewport: 1 column narrow, up to 4 wide.
   */
  import { ScrollArea } from "@foxui/core";
  import LinkViewItem from "./LinkViewItem.svelte";
  import { IconLink } from "../../../../icons/index";
  import type { LinkInfo } from "./types";

  let {
    links,
    emptyMessage = "No links shared yet",
    loadMore,
    hasMore = false,
    loading = false,
  }: {
    links: LinkInfo[];
    emptyMessage?: string;
    /** Called when the user scrolls near the end of the list. */
    loadMore?: () => void;
    /** Whether there are more pages to load. */
    hasMore?: boolean;
    /** First page is still in flight — renders the skeleton grid. */
    loading?: boolean;
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

  /** One card-shaped placeholder, used to build the first-load skeleton. */
  const SKELETON_COUNT = 6;
</script>

{#if loading && !links.length}
  <ScrollArea class="h-full pb-4 w-full @container">
    <div
      class="grid grid-cols-1 gap-3 px-1 pt-1 sm:px-2 @[34rem]:grid-cols-2 @[52rem]:grid-cols-3 @[74rem]:grid-cols-4"
    >
      {#each Array(SKELETON_COUNT) as _, i (i)}
        <div
          class="flex flex-col overflow-hidden rounded-2xl border border-base-300/70 bg-base-100/60 dark:border-base-800 dark:bg-base-900/40"
        >
          <div class="aspect-video w-full animate-pulse bg-base-200/70 dark:bg-base-800/60"></div>
          <div class="flex flex-col gap-2 p-3">
            <div class="h-3 w-16 animate-pulse rounded bg-base-200 dark:bg-base-800"></div>
            <div class="h-4 w-5/6 animate-pulse rounded bg-base-200 dark:bg-base-800"></div>
            <div class="h-3 w-2/3 animate-pulse rounded bg-base-200 dark:bg-base-800"></div>
          </div>
          <div class="h-8 w-full border-t border-base-200/70 dark:border-base-800/70"></div>
        </div>
      {/each}
    </div>
  </ScrollArea>
{:else if links.length}
  <ScrollArea class="h-full pb-4 w-full @container">
    <div class="px-1 pt-1 sm:px-2">
      <div
        class="grid grid-cols-1 gap-3 @[34rem]:grid-cols-2 @[52rem]:grid-cols-3 @[74rem]:grid-cols-4"
      >
        {#each links as link (link.url)}
          <LinkViewItem {link} />
        {/each}
      </div>

      {#if hasMore}
        <div
          bind:this={sentinel}
          class="flex items-center justify-center gap-2 py-6 text-sm text-base-400"
        >
          <span
            class="size-3.5 animate-spin rounded-full border-2 border-base-300 border-t-accent-500 dark:border-base-700 dark:border-t-accent-500"
          ></span>
          Loading more…
        </div>
      {/if}
    </div>
  </ScrollArea>
{:else}
  <div class="h-full w-full flex items-center justify-center">
    <div class="flex max-w-xs flex-col items-center gap-3 px-6 text-center">
      <span
        class="flex size-12 items-center justify-center rounded-2xl border border-base-300/70 bg-base-100/60 text-base-400 dark:border-base-800 dark:bg-base-900/40 dark:text-base-500"
      >
        <IconLink class="size-6" />
      </span>
      <p class="text-sm text-base-500 dark:text-base-400">{emptyMessage}</p>
      <p class="text-xs text-base-500 dark:text-base-400">
        Every link posted here collects in one place, newest first.
      </p>
    </div>
  </div>
{/if}
