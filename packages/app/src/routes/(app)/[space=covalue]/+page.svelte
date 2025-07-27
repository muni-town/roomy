<script lang="ts">
  import { page } from "$app/state";
  import { IDList, RoomyObject, Space } from "@roomy-chat/sdk";
  import { navigate } from "$lib/utils.svelte";
  import { CoState } from "jazz-tools/svelte";

  let space = $derived(
    new CoState(Space, page.params.space, {
      resolve: {
        rootFolder: {
          components: true
        },
      },
    }),
  );

  let children = $derived(new CoState(IDList, space.current?.rootFolder.components.children));

  async function navigateToFirstThread() {
    if (
      !space.current ||
      !children.current ||
      children.current?.length === 0
    )
      return;

    // load roomyobjects and find first thread
    for (const childId of children.current ?? []) {
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
