<script lang="ts">
  import { page } from "$app/state";
  import { useTopicSubscription } from "@roomy-space/sdk/svelte";
  import type { Topic } from "@roomy-space/sdk/svelte";
  import { sync_ } from "$lib/sync.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import ThinSidebar from "$lib/components/sidebar/ThinSidebar.svelte";
  import SpaceSidebar from "$lib/components/sidebar/SpaceSidebar.svelte";
  import { sidebarOverride } from "$lib/components/layout/sidebar.svelte";
  import JoinSpaceModal from "$lib/components/layout/JoinSpaceModal.svelte";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";

  let { children } = $props();

  const spaceId = $derived(page.params.space!);

  const metaQuery = createSpaceMetadataQuery(() => spaceId);

  $effect(() => {
    console.log($state.snapshot(metaQuery))
  })

  // Show join modal when we have metadata and user is not a member.
  // While loading, render the layout underneath (spinner is inside the modal).
  const showJoinModal = $derived(
    metaQuery.isSuccess && metaQuery.data && !metaQuery.data.isMember,
  );

  useTopicSubscription(
    () => sync_.ctx?.topicManager ?? null,
    () => [{ kind: "space", id: spaceId } satisfies Topic],
  );
</script>

<div class="h-full bg-base-50 dark:bg-base-950 text-base-800 dark:text-base-200">
  <MainLayout>
    {#snippet serverBar()}
      <ThinSidebar />
    {/snippet}
    {#snippet sidebar()}
      {#if sidebarOverride.content}
        {@render sidebarOverride.content()}
      {:else}
        <SpaceSidebar {spaceId} />
      {/if}
    {/snippet}
    {@render children()}
  </MainLayout>
</div>

{#if showJoinModal}
  <JoinSpaceModal {spaceId} />
{/if}
