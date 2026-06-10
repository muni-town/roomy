<script lang="ts">
  import { onMount } from "svelte";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { IconPlus } from "@roomy/design/icons";
  import SpaceSidebar from "$lib/components/sidebar/SpaceSidebar.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebarContent } from "$lib/components/layout/sidebar.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import { joinSpace } from "$lib/mutations/space";
  import { queryClient } from "$lib/client";
  import { schemas, cache } from "@roomy-space/sdk";
  import { resolveBlobUrl } from "$lib/utils";
  import ActivityFeed from "$lib/components/feed/ActivityFeed.svelte";

  type Space = typeof schemas.queries.getSpaces.Space.infer;

  const spacesQuery = createSpacesQuery({ includeLeft: true });

  let rejoining = $state<string | null>(null);

  async function rejoin(spaceId: string) {
    rejoining = spaceId;
    try {
      await joinSpace(spaceId);
      await queryClient.invalidateQueries({
        queryKey: cache.queryKey("space.roomy.space.getSpaces"),
      });
    } catch (e) {
      console.error("Failed to rejoin space", e);
    } finally {
      rejoining = null;
    }
  }

  onMount(() => {
    setNavbar(homeNavbar);
    setSidebarContent(homeSidebar);
    return () => {
      setNavbar(undefined);
      setSidebarContent(undefined);
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
  <div class="flex w-full items-center gap-3 px-2 justify-start">
    <Button href="https://a.roomy.space" target="_blank">About Roomy</Button>
  </div>
{/snippet}

{#snippet homeContent()}
  <main class="h-full overflow-y-auto px-4 text-base-950 dark:text-base-50">
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
          <p class="text-sm text-red-600">Error: {spacesQuery.error.message}</p>
        {:else if spacesQuery.data}
          {@const joined = spacesQuery.data.spaces.filter((s) => s.isMember)}
          {@const left = spacesQuery.data.spaces.filter((s) => !s.isMember)}

          {#if left.length > 0}
            <details class="w-full max-w-5xl px-8">
              <summary
                class="font-medium text-sm text-center opacity-70 cursor-pointer select-none hover:text-base-700 dark:hover:text-base-300 transition-colors"
              >
                Left Spaces ({left.length})
              </summary>
              <section class="flex flex-row gap-6 mt-4 justify-center flex-wrap">
                {#each left as space (space.id)}
                  <div
                    class="flex flex-col items-center gap-2 w-32 opacity-60 hover:opacity-100 transition-opacity"
                  >
                    <SpaceAvatar
                      src={resolveBlobUrl(space.avatar)}
                      id={space.id}
                      name={space.name ?? undefined}
                      size={64}
                    />
                    <span
                      class="text-sm font-medium text-center text-base-700 dark:text-base-300 line-clamp-2"
                    >
                      {space.name || "Unnamed Space"}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onclick={() => rejoin(space.id)}
                      disabled={rejoining === space.id}
                    >
                      {rejoining === space.id ? "Joining…" : "Rejoin"}
                    </Button>
                  </div>
                {/each}
              </section>
            </details>
          {/if}

          {#if joined.length > 0}
            <section class="w-full max-w-2xl">
              <h2 class="text-2xl font-bold text-base-900 dark:text-base-100 mb-4">
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