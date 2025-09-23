<script lang="ts">
  import { Badge, NumberInput } from "@fuxui/base";

  import SpaceButton from "./SpaceButton.svelte";
  import type { LoadedSpace } from "./type";

  // load all spaces and accounts
  const allSpaces = $derived(new CoState(IDList, allSpacesListId));

  const loadedSpaces = $state<LoadedSpace[]>([]);
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
      const space = await RoomyEntity.load(spaceId, {
        resolve: {
          components: {
            $each: true,
            $onError: null,
          },
          $onError: null,
        },
      });

      if (!space) continue;

      const loadedSpace: LoadedSpace = {
        space,
      };

      const membersId = space.components?.[AllMembersComponent.id];

      if (membersId) {
        const members = await AllMembersComponent.load(membersId, {
          resolve: {
            $each: {
              account: {
                profile: {
                  $onError: null,
                },
              },
            },
            $onError: null,
          },
        });

        let users = Object.values(members?.perAccount ?? {})
          .filter((a) => a && !a.value?.softDeleted)
          .flat()
          .map((a) => ({
            value: a?.value?.account?.id ?? "",
            label: a?.value?.account?.profile?.name ?? "",
          }));

        loadedSpace.members = users;
      }

      loadedSpaces.push(loadedSpace);
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
    class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5 py-8 mz-8"
  >
    {#each filteredSpaces as space}
      <SpaceButton {space} />
    {/each}
  </div>
{:else}
  <div class="text-sm text-base-500 dark:text-base-400 mt-8">
    No spaces found
  </div>
{/if}
