<script lang="ts">
  /**
   * DiscoverSpacesSection — the horizontally scrolling strip of dismissable
   * space cards on the welcome page.
   *
   * Presentational only. Each card's content is the caller's (`card` is
   * rendered with the space id), because what a card says about a space comes
   * from a lookup this layer does not own; the strip itself owns the heading,
   * the scroll container and the per-card dismiss affordance.
   */
  import type { Snippet } from "svelte";
  import { fade } from "svelte/transition";
  import { IconX } from "../../icons/index";

  let {
    spaceIds,
    onDismiss,
    card,
  }: {
    /** Ids of the spaces to show, in order. An empty list renders nothing. */
    spaceIds: string[];
    onDismiss: (id: string) => void;
    /** The card body for one space, given its id. */
    card: Snippet<[string]>;
  } = $props();
</script>

{#if spaceIds.length > 0}
  <section class="w-full mt-4">
    <h2 class="text-2xl font-bold px-4 text-base-900 dark:text-base-100 mb-4 lg:text-center">
      Discover Spaces
    </h2>
    <div class="flex flex-col lg:items-center w-full">
      <div
        class="discover-cards-scroll flex gap-4 overflow-x-auto snap-x snap-mandatory max-w-full pt-4 pb-4 px-4"
      >
        {#each spaceIds as spaceId (spaceId)}
          <div class="relative snap-start shrink-0 w-72 flex" transition:fade={{ duration: 200 }}>
            <!-- Dismiss button (on the card edge; container has pt to avoid
                 clipping) -->
            <button
              type="button"
              aria-label="Dismiss"
              class="absolute -top-2 -right-2 z-10 size-6 rounded-full bg-base-200 dark:bg-base-700 text-base-500 dark:text-base-300 flex items-center justify-center hover:bg-base-300 dark:hover:bg-base-600 hover:text-base-700 dark:hover:text-base-100 transition-colors shadow-sm"
              onclick={() => onDismiss(spaceId)}
            >
              <IconX class="size-3.5" />
            </button>

            <a
              href={`/${spaceId}`}
              class="h-full w-full flex flex-col items-center gap-3 p-5 rounded-2xl bg-base-50/60 dark:bg-base-800/20 border border-base-200/60 dark:border-base-700/30 text-center transition-colors hover:bg-accent-50 dark:hover:bg-accent-900/20 hover:border-accent-300 dark:hover:border-accent-700/50"
            >
              {@render card(spaceId)}
            </a>
          </div>
        {/each}
      </div>
    </div>
  </section>
{/if}

<style>
  .discover-cards-scroll {
    scroll-padding-inline: 1rem;
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
