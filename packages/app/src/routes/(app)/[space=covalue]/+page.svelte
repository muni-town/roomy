<script lang="ts">
  import { page } from "$app/state";
  import {
    RoomyEntity,
    ChildrenComponent,
    ThreadComponent,
    PageComponent,
  } from "@roomy-chat/sdk";
  import { navigate } from "$lib/utils.svelte";
  import { CoState } from "jazz-tools/svelte";

  let space = $derived(
    new CoState(RoomyEntity, page.params.space, {
      resolve: {
        components: true,
      },
    }),
  );

  async function navigateToFirstChildThreadOrPage(id: string) {
    if (!space.current || !id) return;

    const children = await ChildrenComponent.schema.load(id, {
      resolve: {
        $each: {
          components: {
            $each: true,
            $onError: null,
          },
        },
      },
    });

    for (const child of children ?? []) {
      if (!child || child.softDeleted) continue;

      if (
        child.components?.[ThreadComponent.id] ||
        child.components?.[PageComponent.id]
      ) {
        navigate({
          space: space.current.id,
          object: child.id,
        });
        return;
      } else if (child.components?.[ChildrenComponent.id]) {
        await navigateToFirstChildThreadOrPage(
          child.components?.[ChildrenComponent.id] ?? "",
        );
        return;
      }
    }
  }

  // Automatically navigate to the first object that is a thread or page in the space if we come to this empty space index
  // page. We might have useful features on this index page eventually.
  $effect(() => {
    navigateToFirstChildThreadOrPage(
      space.current?.components[ChildrenComponent.id] ?? "",
    );
  });
</script>
