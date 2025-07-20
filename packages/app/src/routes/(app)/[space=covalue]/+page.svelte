<script lang="ts">
  import { page } from "$app/state";
  import { RoomyEntity, ChildrenComponent } from "@roomy-chat/sdk";
  import { navigate } from "$lib/utils.svelte";
  import { CoState } from "jazz-tools/svelte";

  let space = $derived(
    new CoState(RoomyEntity, page.params.space, {
      resolve: {
        components: true,
      },
    }),
  );

  let children = $derived(
    new CoState(ChildrenComponent.schema, space.current?.components[ChildrenComponent.id]),
  );

  async function navigateToFirstChild() {
    if (!space.current || !children.current || children.current?.length === 0)
      return;

    for (const child of children.current ?? []) {
      if (!child || child.softDeleted) continue;

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
    navigateToFirstChild();
  });
</script>
