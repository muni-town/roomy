<script lang="ts">
  import { page } from "$app/state";
  import { useTopicSubscription } from "@roomy-space/sdk/svelte";
  import type { Topic } from "@roomy-space/sdk/svelte";
  import { auth } from "$lib/auth.svelte";
  import { sync_ } from "$lib/sync.svelte";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import ThinSidebar from "$lib/components/sidebar/ThinSidebar.svelte";
  import SpaceSidebar from "$lib/components/sidebar/SpaceSidebar.svelte";
  import { sidebarOverride } from "$lib/components/layout/sidebar.svelte";

  let { children } = $props();

  const spaceId = $derived(page.params.space!);

  useTopicSubscription(
    () => sync_.ctx?.topicManager ?? null,
    () => [{ kind: "space", id: spaceId } satisfies Topic],
  );
</script>

{#if !auth.authenticated}
  <div class="p-4 text-sm text-base-500">Not authenticated.</div>
{:else}
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
{/if}
