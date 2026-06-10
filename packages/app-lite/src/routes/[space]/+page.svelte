<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import ActivityFeed from "$lib/components/feed/ActivityFeed.svelte";

  const spaceId = $derived(page.params.space!);

  onMount(() => {
    setNavbar(spaceNavbar);
    return () => setNavbar(undefined);
  });
</script>

{#snippet spaceNavbar()}
  <div class="flex-1 text-center font-bold text-lg text-base-900 dark:text-base-100">
    Activity
  </div>
{/snippet}

<main class="h-full overflow-y-auto px-4 py-6">
  <div class="mx-auto max-w-2xl">
    <ActivityFeed {spaceId} limit={50} showSpaceInfo={false} />
  </div>
</main>
