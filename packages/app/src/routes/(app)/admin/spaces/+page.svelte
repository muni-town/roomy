<script lang="ts">
  import { Badge, NumberInput } from "@fuxui/base";

  import { IDList, Space, allSpacesListId, co } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import SpaceButton from "./SpaceButton.svelte";

  // load all spaces and accounts
  const allSpaces = $derived(new CoState(IDList, allSpacesListId));

  const loadedSpaces = $state<co.loaded<typeof Space>[]>([]);
  const filteredSpaces = $derived(
    loadedSpaces.filter(
      (space) => (space?.members?.length ?? 0) >= minimumMemberCount,
    ),
  );

  let isLoading = $state(false);

  async function loadSpaces() {
    if (!allSpaces.current) return;
    if (loadedSpaces.length > 0) return;

    isLoading = true;

    // add all spaces with more than one member to the usedSpaces list
    for (const spaceId of allSpaces.current.toReversed()) {
      const space = await Space.load(spaceId, {
        resolve: {
          $onError: null,
        },
      });
      if (space) {
        loadedSpaces.push(space);
      }
    }

    isLoading = false;
  }

  $effect(() => {
    loadSpaces();
  });

  let minimumMemberCount = $state(0);
</script>

<div class="flex items-center gap-2 font-semibold w-full mb-4">
  Limit to spaces with at least:
</div>
<div class="flex items-center gap-2">
  <NumberInput min={0} max={100} bind:value={minimumMemberCount} />
  member{minimumMemberCount === 1 ? "" : "s"}
</div>

<div class="text-sm text-base-500 dark:text-base-400 mt-6 mb-4 w-full">
  Found <Badge size="md">{filteredSpaces.length}</Badge> spaces
</div>

{#if isLoading}
  <Badge>Loading...</Badge>
{/if}

{#if filteredSpaces.length > 0}
  <div
    class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5 py-8"
  >
    {#each filteredSpaces as space}
      <SpaceButton {space} />
    {/each}
  </div>
{:else}
  <div class="text-sm text-base-500 dark:text-base-400">No spaces found</div>
{/if}
