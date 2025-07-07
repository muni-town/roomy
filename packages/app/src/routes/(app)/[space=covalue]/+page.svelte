<script lang="ts">
  import { page } from "$app/state";
  import { RoomyObject, Space } from "@roomy-chat/sdk";
  import { navigate } from "$lib/utils.svelte";
  import Icon from "@iconify/svelte";
  import { CoState } from "jazz-svelte";

  let space = $derived(
    new CoState(Space, page.params.space, {
      resolve: {
        rootFolder: {
          childrenIds: true,
        },
      },
    }),
  );

  async function navigateToFirstThread() {
    if (
      !space.current ||
      !space.current.rootFolder ||
      space.current.rootFolder.childrenIds.length === 0
    )
      return;

    // load roomyobjects and find first thread
    for (const childId of space.current.rootFolder.childrenIds) {
      const child = await RoomyObject.load(childId);
      if (!child) continue;

      navigate({
        space: space.current.id,
        object: child.id,
      });
      return;
    }
  }

  // Automatically navigate to the first object in the space if we come to this empty space index
  // page. We might have useful features on this index page eventually.
  $effect(() => {
    navigateToFirstThread();
  });
</script>

<main class="flex h-full">
  <div class="m-auto text-white">
    <Icon icon="ri:group-fill" class="text-6xl" />
  </div>
</main>
