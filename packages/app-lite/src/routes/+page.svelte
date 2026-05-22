<script lang="ts">
  import { env } from "$env/dynamic/public";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import EarlyAlphaWarning from "@roomy/design/components/helper/EarlyAlphaWarning.svelte";
  import SpaceCard from "@roomy/design/components/spaces/SpaceCard.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { IconPlus } from "@roomy/design/icons";
  import MainLayout from "$lib/components/layout/MainLayout.svelte";
  import ThinSidebar from "$lib/components/sidebar/ThinSidebar.svelte";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import { joinSpace } from "$lib/mutations/space";
  import { queryClient } from "$lib/client";
  import { schemas, cache } from "@roomy-space/sdk";

  type Space = typeof schemas.queries.getSpaces.Space.infer;

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

  $effect(() => {
    setNavbar(homeNavbar);
    return () => setNavbar(undefined);
  });
</script>

<MainLayout>
  {#snippet serverBar()}
    <ThinSidebar />
  {/snippet}
  {@render homeContent()}
</MainLayout>

{#snippet homeNavbar()}
  <div class="flex w-full items-center gap-3 px-2">
    <Button href="https://a.roomy.space" target="_blank">About Roomy</Button>
  </div>
{/snippet}

{#snippet homeContent()}
  {@const spacesQuery = createSpacesQuery()}

  <main class="h-full overflow-y-auto px-4">
    <div class="flex flex-col items-center justify-start py-8">
      <div class="flex flex-col gap-8 items-center w-full">
        <h1 class="text-5xl font-bold text-center text-base-950 dark:text-base-50">
          Hi Roomy 👋
        </h1>
        <p class="text-lg font-medium max-w-2xl text-center text-pretty">
          A digital gardening platform for communities. Flourish in Spaces,
          curating knowledge and conversations together.
        </p>

        <EarlyAlphaWarning />

        <hr class="w-full max-w-2xl border-base-200 dark:border-base-800" />

        <Button class="gap-2" href="/new">
          <IconPlus />
          Create Space
        </Button>

        {#if spacesQuery.isPending}
          <p class="text-sm text-base-400">Loading spaces…</p>
        {:else if spacesQuery.isError}
          <p class="text-sm text-red-600">Error: {spacesQuery.error.message}</p>
        {:else if spacesQuery.data}
          {@const joined = spacesQuery.data.spaces.filter((s) => s.isMember)}
          {@const left = spacesQuery.data.spaces.filter((s) => !s.isMember)}

          {#if joined.length > 0}
            <h2 class="text-3xl font-bold text-base-900 dark:text-base-100">
              Your Spaces
            </h2>
            <section class="flex flex-row gap-8 mx-8 justify-center flex-wrap max-w-5xl">
              {#each joined as space (space.id)}
                {@render spaceCard(space)}
              {/each}
            </section>
          {:else}
            <p class="text-lg font-medium text-center">
              You haven't joined any spaces yet.
            </p>
          {/if}

          {#if left.length > 0}
            <hr class="w-full max-w-2xl border-base-200 dark:border-base-800" />
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
                      src={space.avatar ?? undefined}
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
        {/if}
      </div>
    </div>
  </main>
{/snippet}

{#snippet spaceCard(space: Space)}
  <SpaceCard
    name={space.name ?? undefined}
    description={space.description ?? undefined}
    href={`/${space.id}`}
  >
    {#snippet avatar()}
      <SpaceAvatar
        src={space.avatar ?? undefined}
        id={space.id}
        name={space.name ?? undefined}
        size={96}
      />
    {/snippet}
  </SpaceCard>
{/snippet}
