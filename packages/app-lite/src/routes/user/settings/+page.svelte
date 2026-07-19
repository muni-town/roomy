<script lang="ts">
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import ThemeSettings from "@roomy/design/components/user/ThemeSettings.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import { joinSpace } from "$lib/mutations/space";
  import { queryClient } from "$lib/client";
  import { cache } from "@roomy-space/sdk";
  import { resolveBlobUrl } from "$lib/utils";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";

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
</script>

<div class="flex flex-col gap-10">
  <!-- Theme section -->
  <section>
    <h2 class="text-base font-semibold mb-4 text-base-900 dark:text-base-100">
      Theme
    </h2>
    <ThemeSettings />
  </section>

  <!-- Left Spaces section -->
  <section>
    <h2 class="text-base font-semibold mb-4 text-base-900 dark:text-base-100">
      Left Spaces
    </h2>

    {#if spacesQuery.isPending}
      <p class="text-sm text-base-400">Loading spaces…</p>
    {:else if spacesQuery.isError}
      <ErrorMessage message="Error: {spacesQuery.error.message}" class="py-8" />
    {:else if spacesQuery.data}
      {@const left = spacesQuery.data.spaces.filter((s: { isMember: boolean }) => !s.isMember)}

      {#if left.length === 0}
        <p class="text-sm text-base-400">No left spaces.</p>
      {:else}
        <div class="flex flex-row gap-6 flex-wrap">
          {#each left as space (space.id)}
            <div
              class="flex flex-col items-center gap-2 w-32 opacity-85 hover:opacity-100 transition-opacity"
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
        </div>
      {/if}
    {/if}
  </section>
</div>
