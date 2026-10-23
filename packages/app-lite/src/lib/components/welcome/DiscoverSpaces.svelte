<script lang="ts">
  /**
   * A single discoverable-space card's data: fetches the space's metadata via
   * the `space.roomy.space.getMetadata` XRPC query (public spaces allow
   * anonymous read access) and hands the resolved, pending or failed state to
   * `@roomy/design`'s card body, which renders it.
   */
  import DiscoverSpaceCard from "@roomy/design/components/marketing/DiscoverSpaceCard.svelte";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";

  let { spaceId }: { spaceId: string } = $props();

  const metaQuery = createSpaceMetadataQuery(() => spaceId, {
    enabled: !!spaceId,
  });

  const space = $derived({
    id: spaceId,
    pending: metaQuery.isPending,
    failed: metaQuery.isLoadingError,
    name: metaQuery.data?.name ?? undefined,
    description: metaQuery.data?.description ?? undefined,
    avatar: metaQuery.data?.avatar,
  });
</script>

<DiscoverSpaceCard {space} />
