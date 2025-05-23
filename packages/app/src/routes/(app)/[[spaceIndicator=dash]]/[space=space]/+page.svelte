<script lang="ts">
  import { page } from "$app/state";
  import { globalState } from "$lib/global.svelte";
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { Category, Channel } from "@roomy-chat/sdk";
  import { untrack } from "svelte";

  // Automatically navigate to the first channel in the space if we come to this empty space index
  // page. We might have useful features on this index page eventually.
  $effect(() => {
    const space = page.params.space;
    if (!space || !globalState.space || globalState.loadedSpace !== space)
      return;

    untrack(async () => {
      // Check if there's a saved state for this space
      const lastEntity = globalState.getLastEntity(space);
      if (lastEntity) {
        return
      }

      // Only navigate to first channel if no saved state exists
      for (const item of (await globalState.space.sidebarItems.items()) || []) {
        const category = item.tryCast(Category);
        const channel = item.tryCast(Channel);
        if (category) {
          for (const channel of await category.channels.items()) {
            return navigate({
              space,
              channel: channel.id,
            });
          }
        } else if (channel) {
          return navigate({
            space,
            channel: channel.id,
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
