<script lang="ts">
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import SidebarMain from "$lib/components/sidebars/SidebarMain.svelte";
  import { current } from "$lib/queries.svelte";

  async function navigateToFirstChildThreadOrPage(id: string) {
    // if (!space.current || !id) return;
    // const children = await ChildrenComponent.load(id, {
    //   resolve: {
    //     $each: {
    //       components: {
    //         $each: true,
    //         $onError: null,
    //       },
    //     },
    //   },
    // });
    // for (const child of children ?? []) {
    //   if (!child || child.softDeleted) continue;
    //   if (
    //     child.components?.[ThreadComponent.id] ||
    //     child.components?.[PageComponent.id]
    //   ) {
    //     navigate({
    //       space: space.current.id,
    //       object: child.id,
    //     });
    //     return;
    //   } else if (child.components?.[ChildrenComponent.id]) {
    //     await navigateToFirstChildThreadOrPage(
    //       child.components?.[ChildrenComponent.id] ?? "",
    //     );
    //     return;
    //   }
    // }
  }

  // Automatically navigate to the first object that is a thread or page in the space if we come to this empty space index
  // page. We might have useful features on this index page eventually.
  $effect(() => {
    // navigateToFirstChildThreadOrPage(
    //   space.current?.components?.[ChildrenComponent.id] ?? "",
    // );
  });
</script>

<MainLayout>
  {#snippet sidebar()}
    <SidebarMain />
  {/snippet}

  {#snippet navbar()}
    <div class="flex flex-col items-center justify-between w-full px-2">
      <h2
        class="text-lg font-bold w-full py-4 text-base-900 dark:text-base-100 flex items-center gap-2"
      >
        <span>{current.spaceMeta?.name}</span>
      </h2>
    </div>
  {/snippet}

  <div class="flex-1 flex items-center justify-center">
    <h1 class="text-xl px-8 text-center text-base-900 dark:text-base-100">
      This space has nothing in it. The admin has to create something before you
      can do anything here. 👀
    </h1>
  </div>
</MainLayout>
