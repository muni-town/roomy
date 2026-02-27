<script lang="ts">
  import { getAppState } from "$lib/queries";
  import Error from "$lib/components/modals/Error.svelte";
  import JoinSpaceModal from "$lib/components/modals/JoinSpaceModal.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import { IconLoading } from "@roomy/design/icons";
  import { page } from "$app/state";

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
    <Error goHome={true} tellUs={false}>
      {#if app.space.message}
        <p class="text-sm text-red-700 dark:text-red-400 mb-3">
          {app.space.message}
        </p>
      {/if}
      <p class="text-sm text-base-500 dark:text-base-400 mb-3">
        We couldn't find a space at
        <span
          class="font-mono bg-base-200 dark:bg-base-800 px-1.5 py-0.5 rounded"
        >
          {page.params.space}
        </span>
      </p>
      <div class="text-sm text-base-500 dark:text-base-400 space-y-1">
        <p>This could mean:</p>
        <ul class="text-left list-disc list-inside ml-4">
          <li>The space doesn't exist yet</li>
          <li>The handle hasn't been linked to a space</li>
          <li>The URL may be incorrect</li>
        </ul>
      </div>
    </Error>
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
