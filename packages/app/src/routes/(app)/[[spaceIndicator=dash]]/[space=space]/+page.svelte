<script lang="ts">
  import { page } from "$app/state";
  import { Space } from "$lib/jazz/schema";
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { CoState } from "jazz-svelte";

  let space = $derived(
    new CoState(Space, page.params.space, {
      resolve: {
        channels: {
          $each: true,
          $onError: null,
        },
      },
    }),
  );

  // Automatically navigate to the first channel in the space if we come to this empty space index
  // page. We might have useful features on this index page eventually.
  $effect(() => {
    if (!space.current || !space.current.channels || space.current.channels.length === 0) return;

    return navigate({
      space: space.current.id,
      channel: space.current.channels[0]?.id,
    });
  });
</script>

<main class="flex h-full">
  <div class="m-auto text-white">
    <Icon icon="ri:group-fill" class="text-6xl" />
  </div>
</main>
