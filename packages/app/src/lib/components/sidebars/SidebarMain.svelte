<script lang="ts">
  import { page } from "$app/state";
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import {
    RoomyAccount,
    RoomyEntity,
    ChildrenComponent,
    co,
    // SubThreadsComponent,
  } from "@roomy-chat/sdk";

  import SidebarObjectList from "./SidebarObjectList.svelte";
  import MainSidebarSpace from "./MainSidebarSpace.svelte";
  import EditObjectModal from "../modals/EditObjectModal.svelte";
  import { Button } from "@fuxui/base";
  import Icon from "@iconify/svelte";

  let space = $derived(
    page.params?.space
      ? new CoState(RoomyEntity, page.params.space, {
          resolve: {
            components: {
              $each: true,
              $onError: null,
            },
          },
        })
      : null,
  );

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: true,
      root: true,
    },
  });

  let children = $derived(
    new CoState(
      ChildrenComponent.schema,
      space?.current?.components?.[ChildrenComponent.id],
      {
        resolve: {
          $each: {
            components: {
              $each: true,
              $onError: null,
            },
            $onError: null,
          },
        },
      },
    ),
  );

  let isEditing = $state(false);

  let openEditObjectModal = $state(false);

  let entity = $state<co.loaded<typeof RoomyEntity> | undefined | null>(null);

  function editEntity(editEntity: co.loaded<typeof RoomyEntity>) {
    console.log("editEntity", editEntity);
    openEditObjectModal = true;
    entity = editEntity;
  }
</script>

<!-- Header -->
<MainSidebarSpace bind:isEditing />

<div class="w-full py-2 px-2">
  {#if isEditing}
    <Button
      class="w-full justify-start mb-4"
      onclick={() => (isEditing = false)}
    >
      <Icon icon="lucide:check" class="size-4" />
      Finish editing</Button
    >
  {/if}

  <SidebarObjectList
    children={children.current}
    me={me.current}
    bind:isEditing
    {editEntity}
    currentEntity={space?.current}
    space={space?.current}
  />
</div>

<EditObjectModal bind:open={openEditObjectModal} bind:entity />
