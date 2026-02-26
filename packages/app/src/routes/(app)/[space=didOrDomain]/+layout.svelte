<script lang="ts">
  import { page } from "$app/state";
  import { peer } from "$lib/workers";
  import type { SpaceIdOrHandle } from "$lib/workers/types";

  // When this layout loads, we have access to page.params.space
  // We should notify the peer so it can prioritize materialization
  $effect(() => {
    const spaceId = page.params.space;
    if (spaceId) {
      console.debug("[Space Layout] Setting current space:", spaceId);
      peer.setCurrentSpace(spaceId as SpaceIdOrHandle);
    }
  });
</script>

<slot />
