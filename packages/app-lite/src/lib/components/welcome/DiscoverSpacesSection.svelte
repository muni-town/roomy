<script lang="ts">
  import { createSpacesQuery } from "$lib/queries/spaces";
  import DiscoverSpaceCard from "./DiscoverSpaces.svelte";

  /**
   * Discoverable spaces section. Hardcoded for now — surfaces a small set of
   * spaces the user hasn't joined yet. Uses the cached `getSpaces` query to
   * exclude spaces the user is already a member of. Each card is dismissable;
   * dismissed ids are tracked in local state so they disappear (session-only).
   */
  const DISCOVERABLE_SPACES = [
    "did:plc:4moccs43r5v2xzkynae3xk2u",
    "did:plc:gnwy2zbm3hu4gfdawzxmpb2s",
  ];

  // Cached query of the user's joined spaces — no extra network round trip if
  // the homepage already loaded it.
  const spacesQuery = createSpacesQuery();

  // DIDs the user is currently a member of.
  const joinedIds = $derived(
    new Set(
      (spacesQuery.data?.spaces ?? [])
        .filter((s) => s.isMember)
        .map((s) => s.id),
    ),
  );

  let dismissed = $state<Set<string>>(new Set());

  const visible = $derived(
    DISCOVERABLE_SPACES.filter(
      (id) => !dismissed.has(id) && !joinedIds.has(id),
    ),
  );

  function dismiss(id: string) {
    dismissed = new Set([...dismissed, id]);
  }
</script>

{#if visible.length > 0}
  <section class="w-full mt-4">
    <h2 class="text-2xl font-bold px-4 text-base-900 dark:text-base-100 mb-4 lg:text-center">
      Discover Spaces
    </h2>
    <div class="flex flex-col lg:items-center w-full">
      <div
        class="discover-cards-scroll flex gap-4 overflow-x-auto snap-x snap-mandatory max-w-full pt-4 pb-4 px-4"
      >
        {#each visible as spaceId (spaceId)}
          <DiscoverSpaceCard {spaceId} onDismiss={dismiss} />
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