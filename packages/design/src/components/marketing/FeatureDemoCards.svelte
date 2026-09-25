<script lang="ts">
  import { IconMessageCircle, IconShare, IconHashtag } from "@roomy/design/icons";
</script>

<div class="space-cards-scroll flex gap-4 overflow-x-auto snap-x snap-mandatory max-w-full pb-4 px-4">
  <div class="flex flex-col items-center gap-3 p-5 rounded-2xl bg-base-100 dark:bg-base-800/40 border border-base-200 dark:border-base-700/50 text-center snap-start shrink-0 w-72">
    <div class="size-10 rounded-xl bg-accent-100 dark:bg-accent-900/30 flex items-center justify-center text-accent-600 dark:text-accent-400">
      <IconHashtag class="size-5" />
    </div>
    <h3 class="font-semibold text-sm text-base-900 dark:text-base-100">Channels &amp; Threads</h3>
    <p class="text-xs text-base-500 dark:text-base-400 leading-relaxed">
      Organize conversations into channels and dive deep with threaded discussions.
    </p>
  </div>

  <div class="flex flex-col items-center gap-3 p-5 rounded-2xl bg-base-100 dark:bg-base-800/40 border border-base-200 dark:border-base-700/50 text-center snap-start shrink-0 w-72">
    <div class="size-10 rounded-xl bg-accent-100 dark:bg-accent-900/30 flex items-center justify-center text-accent-600 dark:text-accent-400">
      <IconMessageCircle class="size-5" />
    </div>
    <h3 class="font-semibold text-sm text-base-900 dark:text-base-100">Communities</h3>
    <p class="text-xs text-base-500 dark:text-base-400 leading-relaxed">
      Invite members, set roles, and build a space that feels like home.
    </p>
  </div>

  <div class="flex flex-col items-center gap-3 p-5 rounded-2xl bg-base-100 dark:bg-base-800/40 border border-base-200 dark:border-base-700/50 text-center snap-start shrink-0 w-72">
    <div class="size-10 rounded-xl bg-accent-100 dark:bg-accent-900/30 flex items-center justify-center text-accent-600 dark:text-accent-400">
      <IconShare class="size-5" />
    </div>
    <h3 class="font-semibold text-sm text-base-900 dark:text-base-100">AT Protocol</h3>
    <p class="text-xs text-base-500 dark:text-base-400 leading-relaxed">
      Built on the AT Protocol — open, portable, and interoperable by design.
    </p>
  </div>
</div>

<style>
  .space-cards-scroll {
    /* Offset snap landing points so cards come to rest slightly inset
       from the scroller's padding edge. */
    scroll-padding-inline: 1rem;
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