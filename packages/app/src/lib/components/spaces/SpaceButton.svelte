<script lang="ts">
  import SpaceAvatar from "./SpaceAvatar.svelte";
  import type { SpaceMeta } from "$lib/queries";
  import SpaceCard from "@roomy/design/components/spaces/SpaceCard.svelte";

  let { space }: { space: SpaceMeta | undefined } = $props();

  const href = $derived(space ? `/${space.handle || space.id}` : undefined);
</script>

<SpaceCard
  name={space?.name}
  description={space?.description}
  {href}
>
  {#snippet avatar()}
    <SpaceAvatar imageUrl={space?.avatar} id={space?.id} size={96} />
  {/snippet}
</SpaceCard>
