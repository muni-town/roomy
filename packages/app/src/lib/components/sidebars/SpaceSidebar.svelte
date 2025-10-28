<script lang="ts">
  import { page } from "$app/state";
  import { spaceTree } from "$lib/queries.svelte";
  import SidebarItemList from "./SidebarItemList.svelte";
  import SpaceSidebarHeader from "./SpaceSidebarHeader.svelte";
  // import EditObjectModal from "../modals/EditObjectModal.svelte";
  import { Button } from "@fuxui/base";

  import IconBasilCheckSolid from "~icons/basil/check-solid";
  import IconHeroiconsHome from "~icons/heroicons/home";

  // at the top level there can be categories, channels or pages
  // under categories there can be channels or pages
  // under channels there can be threads or pages

  let isEditing = $state(false);

  // let openEditObjectModal = $state(false);

  // function editEntity(editEntity: co.loaded<typeof RoomyEntity>) {
  //   console.log("editEntity", editEntity);
  //   openEditObjectModal = true;
  //   entity = editEntity;
  // }
</script>

<!-- Header -->
<SpaceSidebarHeader bind:isEditing />

{#if isEditing}
  <Button class="w-full justify-start mb-4" onclick={() => (isEditing = false)}>
    <IconBasilCheckSolid class="size-4" />
    Finish editing</Button
  >
{/if}

<div class="w-full pt-2 px-2">
  <Button
    class="w-full justify-start mb-2"
    variant="ghost"
    href={`/${page.params.space}`}
    data-current={!page.params.object}
  >
    <IconHeroiconsHome class="shrink-0" />
    Index
  </Button>

  <hr class="my-2 border-base-800/10 dark:border-base-100/5" />

  <!-- <pre>{JSON.stringify(spaceTree.result, undefined, '  ')}</pre> -->
  <!-- {#each spaceTree.result || [] as item}
    {#if item.type == "category"}
      <div>{item.name}</div>
      <div class="ml-3">
        {#each item.channels as channel}
          <div>
            {channel.name}
          </div>
        {/each}
      </div>
    {:else if item.type == "channel"}
      <div>
        {item.name}
      </div>
    {/if}
  {/each} -->

  <SidebarItemList bind:isEditing items={spaceTree.result || []} />
</div>

<!-- <EditObjectModal bind:open={openEditObjectModal} bind:entity /> -->
