<script lang="ts">
  import { page } from "$app/state";
  import { spaceTree } from "$lib/queries.svelte";
  import SidebarObjectList from "./SidebarObjectList.svelte";

  // import SidebarObjectList from "./SidebarObjectList.svelte";
  import SpaceSidebarHeader from "./SpaceSidebarHeader.svelte";
  // import EditObjectModal from "../modals/EditObjectModal.svelte";
  import { Button } from "@fuxui/base";
  import Icon from "@iconify/svelte";

  // let space = $derived(
  //   page.params?.space
  //     ? new CoState(RoomyEntity, page.params.space, {
  //         resolve: {
  //           components: {
  //             $each: true,
  //             $onError: null,
  //           },
  //         },
  //       })
  //     : null,
  // );

  // const me = new AccountCoState(RoomyAccount, {
  //   resolve: {
  //     profile: true,
  //     root: true,
  //   },
  // });

  // let children = $derived(
  //   new CoState(
  //     ChildrenComponent,
  //     space?.current?.components?.[ChildrenComponent.id],
  //     {
  //       resolve: {
  //         $each: {
  //           components: {
  //             $each: true,
  //             $onError: null,
  //           },
  //           $onError: null,
  //         },
  //       },
  //     },
  //   ),
  // );

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

<div class="w-full py-2 px-2">
  <Button
    class="w-full justify-start mb-4"
    variant="ghost"
    href={`/${page.params.space}`}
  >
    Index
  </Button>
  {#if isEditing}
    <Button
      class="w-full justify-start mb-4"
      onclick={() => (isEditing = false)}
    >
      <Icon icon="lucide:check" class="size-4" />
      Finish editing</Button
    >
  {/if}

  <!-- <pre>{JSON.stringify(spaceTree.result, undefined, '  ')}</pre> -->
  {#each spaceTree.result || [] as item}
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
  {/each}

  <!-- <SidebarObjectList bind:isEditing /> -->
</div>

<!-- <EditObjectModal bind:open={openEditObjectModal} bind:entity /> -->
