<script lang="ts">
  import { page } from "$app/state";
  import { flags } from "$lib/flags";
  import { current, sidebar } from "$lib/queries";
  import SidebarItemList from "./SidebarItemList.svelte";
  import SpaceSidebarHeader from "./SpaceSidebarHeader.svelte";
  import EditRoomModal from "../modals/EditRoomModal.svelte";
  import { Button } from "@fuxui/base";

  import IconBasilCheckSolid from "~icons/basil/check-solid";
  import IconHeroiconsHome from "~icons/heroicons/home";

  // at the top level there can be categories, channels or pages
  // under categories there can be channels or pages
  // under channels there can be threads or pages

  let isEditing = $state(false);

  function editSidebarItem() {
    openEditRoomModal = true;
  }

  let openEditRoomModal = $state(false);
</script>

<!-- Header -->
<SpaceSidebarHeader bind:isEditing />

{#if current.space.status === "loading"}
  <div class="px-4 mt-2">
    <div class="h-4 bg-base-200 rounded animate-pulse w-3/4 mb-2"></div>
    <div class="h-3 bg-base-200 rounded animate-pulse w-1/2"></div>
  </div>
{:else}
  {#if isEditing}
    <Button
      class="justify-start mb-4 mx-2 self-stretch"
      onclick={() => (isEditing = false)}
    >
      <IconBasilCheckSolid class="size-4" />
      Finish editing</Button
    >
  {/if}

  <div class="w-full pt-2 px-2">
    {#if flags.threadsList}
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
    {/if}

    <SidebarItemList
      bind:isEditing
      {editSidebarItem}
      items={sidebar.result || []}
    />
  </div>
{/if}

<EditRoomModal bind:open={openEditRoomModal} />
