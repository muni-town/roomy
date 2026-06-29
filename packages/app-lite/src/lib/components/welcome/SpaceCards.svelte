<script lang="ts">
  import { resolveBlobUrl } from "$lib/utils";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";

  let {
    spaces,
  }: {
    spaces: { id: string; name?: string; avatar?: string; unreadCount?: number }[];
  } = $props();
</script>

<!-- Wrapper insets the whole row from the page edges (replaces the
     overflowing mx-2 attempt) so the scroller is slightly narrower
     than full width without exceeding its parent. -->
<div class="w-full px-2">
  <div
    class="space-cards-scroll flex gap-4 overflow-x-auto snap-x snap-mandatory w-full pb-4 px-8"
  >
    {#each spaces as space (space.id)}
    <a
      href={`/${space.id}`}
      class="flex flex-col items-center gap-3 p-5 rounded-2xl bg-base-50/60 dark:bg-base-800/20 border border-base-200/60 dark:border-base-700/30 text-center transition-colors hover:bg-accent-50 dark:hover:bg-accent-900/20 hover:border-accent-300 dark:hover:border-accent-700/50 snap-start shrink-0 w-44"
    >
      <SpaceAvatar
        src={resolveBlobUrl(space.avatar)}
        id={space.id}
        name={space.name ?? undefined}
        size={88}
        shape="squircle"
      />
      <h3 class="font-semibold text-sm text-base-900 dark:text-base-100 truncate w-full">
        {space.name ?? "Unnamed Space"}
      </h3>
      <div class="flex items-center justify-center gap-1.5 w-full">
        <span class="size-1.5 rounded-full bg-accent-500 dark:bg-white shrink-0"></span>
        <span class="text-xs text-base-500 dark:text-base-400 leading-relaxed truncate">
          {#if space.unreadCount && space.unreadCount > 0}
            {space.unreadCount} unread
          {:else}
            Up to date
          {/if}
        </span>
      </div>
    </a>
  {/each}
  </div>
</div>

<style>
  .space-cards-scroll {
    /* Offset snap landing points so cards come to rest slightly inset
       from the scroller's padding edge. */
    scroll-padding-inline: 0.5rem;
    /* Fade cards out at the left/right edges of the scroll viewport. */
    -webkit-mask-image: linear-gradient(
      to right,
      transparent 0,
      black 1rem,
      black calc(100% - 1rem),
      transparent 100%
    );
    mask-image: linear-gradient(
      to right,
      transparent 0,
      black 1rem,
      black calc(100% - 1rem),
      transparent 100%
    );
  }
</style>