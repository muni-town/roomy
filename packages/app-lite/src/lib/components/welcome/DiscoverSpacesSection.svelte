<script lang="ts">
  /**
   * Discover Spaces section. Hardcoded for now — surfaces a small set of
   * spaces the user hasn't joined yet. Uses the cached `getSpaces` query to
   * exclude spaces the user is already a member of. Each card is dismissable;
   * dismissed ids are tracked in local state so they disappear (session-only).
   *
   * The strip's frame is `@roomy/design`'s; this wrapper owns what is
   * discoverable and resolves each card's metadata.
   */
  import DiscoverSpacesSectionShell from "@roomy/design/components/marketing/DiscoverSpacesSection.svelte";
  import DiscoverSpaceCard from "./DiscoverSpaces.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";

  const DISCOVERABLE_SPACES = [
    "did:plc:4moccs43r5v2xzkynae3xk2u",
    "did:plc:gnwy2zbm3hu4gfdawzxmpb2s",
  ];

  // Cached query of the user's joined spaces. The query refetches on mount
  // (it is a pulled view — see `queries/spaces.ts`), so this costs one request
  // per mount of this section rather than sharing the homepage's.
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

<DiscoverSpacesSectionShell spaceIds={visible} onDismiss={dismiss}>
  {#snippet card(spaceId)}
    <DiscoverSpaceCard {spaceId} />
  {/snippet}
</DiscoverSpacesSectionShell>
