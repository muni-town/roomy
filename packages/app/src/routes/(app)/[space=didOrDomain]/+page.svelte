<script lang="ts">
  import { getAppState } from "$lib/queries";
  import SpaceNotFound from "$lib/components/modals/SpaceNotFound.svelte";
  import JoinSpaceModal from "$lib/components/modals/JoinSpaceModal.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import { IconLoading } from "@roomy/design/icons";

  const app = getAppState();
  import { navigate } from "$lib/utils.svelte";

  $effect(() => {
    if (!app.joinedSpace) return;
    const firstCategory = app.categories?.[0];
    if (firstCategory?.type === "space.roomy.category") {
      const firstChild = firstCategory.children?.[0]?.id;
      if (firstChild)
        navigate({
          space: app.joinedSpace.handle || app.joinedSpace.id,
          channel: firstChild,
        });
    }
  });
</script>

{#if app.space.status === "error"}
  <MainLayout>
    <SpaceNotFound message={app.space.message} />
  </MainLayout>
{:else if app.space.status === "invited"}
  <MainLayout>
    <JoinSpaceModal />
  </MainLayout>
{:else}
  <MainLayout>
    <div class="flex items-center justify-center h-full w-full">
      <IconLoading
        font-size="2em"
        class="animate-spin text-primary"
      />
    </div>
  </MainLayout>
{/if}
