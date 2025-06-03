<script lang="ts">
  import { page } from "$app/state";
  import { globalState } from "$lib/global.svelte";
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  // import { Category, Channel } from "@roomy-chat/sdk";
  import { untrack } from "svelte";

  // Automatically navigate to the first channel in the space if we come to this empty space index
  // page. We might have useful features on this index page eventually.
  $effect(() => {
    const channelId = globalState.space?.channels?.[0]?.id
    const spaceId = page.params.space
    console.log("spaces",globalState.catalog?.spaces, "space params", page.params.space, "loaded", globalState.loadedSpace)
    if (!globalState.catalog?.spaces || globalState.loadedSpace !== spaceId || !spaceId)
      return;

    console.log("continue")
    untrack(async () => {
      for (const space of globalState.catalog?.spaces || []) {
        if (space?.id === spaceId) {
          console.log("nav")
          return navigate({
            space: spaceId, channel: channelId
          });
        }
      }
    });
  });
</script>

<main class="flex h-full">
  <div class="m-auto text-white">
    <Icon icon="ri:group-fill" class="text-6xl" />
  </div>
</main>
