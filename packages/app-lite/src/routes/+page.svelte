<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import { IconPlus } from "@roomy/design/icons";
  import SpaceSidebar from "$lib/components/sidebar/SpaceSidebar.svelte";
  import RoomyHomeCard from "$lib/components/sidebar/RoomyHomeCard.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebarContent } from "$lib/components/layout/sidebar.svelte";
  import { setWideSidebar } from "$lib/components/layout/wide-sidebar.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import ActivityFeed from "$lib/components/feed/ActivityFeed.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";

  const spacesQuery = createSpacesQuery({ includeLeft: true });

  onMount(() => {
    setNavbar(homeNavbar);
    setSidebarContent(homeSidebar);
    setWideSidebar(true);
    return () => {
      setNavbar(undefined);
      setSidebarContent(undefined);
      setWideSidebar(false);
    };
  });
</script>

{#snippet homeSidebar()}
  <SpaceSidebar />
{/snippet}

<div class="h-full bg-base-50 dark:bg-base-950 text-base-800 dark:text-base-200">
  {@render homeContent()}
</div>

{#snippet homeNavbar()}
  <div class="flex w-full items-center justify-between gap-3 px-2">
    <RoomyHomeCard onClick={() => goto("/")} small={false} />
    <Button href="https://a.roomy.space" target="_blank">About Roomy</Button>
  </div>
{/snippet}

{#snippet homeContent()}
  <main class="h-full overflow-y-auto text-base-950 dark:text-base-50">
    <div class="flex flex-col items-center justify-start py-8">
      <div class="flex flex-col gap-8 items-center w-full">
        <!-- <h1 class="text-5xl font-bold text-center">
          Hi Roomy 👋
        </h1>
        <p class="text-lg font-medium max-w-2xl text-center text-pretty">
          A digital gardening platform for communities. Flourish in Spaces,
          curating knowledge and conversations together.
        </p> -->


        {#if spacesQuery.isPending}
          <p class="text-sm text-base-400">Loading spaces…</p>
        {:else if spacesQuery.isError}
          <ErrorMessage message="Error: {spacesQuery.error.message}" class="py-8 justify-center" />
        {:else if spacesQuery.data}
          {@const joined = spacesQuery.data.spaces.filter((s) => s.isMember)}

          {#if joined.length > 0}
            <section class="w-full">
              <h2 class="text-2xl font-bold px-4 text-base-900 dark:text-base-100 mb-4">
                Recent Activity
              </h2>
              <ActivityFeed limit={20} />
            </section>
          {/if}
        {/if}
      </div>
    </div>
  </main>
{/snippet}