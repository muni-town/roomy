<script lang="ts">
  import type { co } from "jazz-tools";
  import SidebarObject from "./SidebarObject.svelte";
  import {
    addToFolder,
    removeFromFolder,
    RoomyEntity,
    type ChildrenComponent,
    type RoomyAccount,
  } from "@roomy-chat/sdk";
  import {
    TRIGGERS,
    dragHandleZone,
    dragHandle,
    type Item,
  } from "svelte-dnd-action";
  import Icon from "@iconify/svelte";

  let {
    children,
    me,
    isEditing = $bindable(false),
    editEntity,
    currentEntity,
  }: {
    children: co.loaded<typeof ChildrenComponent.schema> | undefined | null;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
    isEditing?: boolean;
    editEntity?: (entity: co.loaded<typeof RoomyEntity>) => void;
    currentEntity?: co.loaded<typeof RoomyEntity> | undefined | null;
  } = $props();

  let orderedChildren = $derived(children ?? []);

  function handleDndConsider(e: CustomEvent) {
    orderedChildren = e.detail.items.filter((x: any) => x && !x?.softDeleted);
  }
  async function handleDndFinalize(e: CustomEvent) {
    console.log("finalize", e);

    const elementId = e.detail.info.id;
    const element = await RoomyEntity.load(elementId, {
      resolve: {
        components: {
          $each: true,
          $onError: null,
        },
      },
    });

    if (e.detail.info.trigger === TRIGGERS.DROPPED_INTO_ANOTHER) {
      if (element && currentEntity) {
        await removeFromFolder(currentEntity, element);
      }
    } else if (e.detail.info.trigger === TRIGGERS.DROPPED_INTO_ZONE) {
      if (element && currentEntity) {
        await removeFromFolder(currentEntity, element);
      }
      // find new index
      const newIndex = e.detail.items.findIndex((x: any) => x.id === elementId);
      // add to folder
      if (element && currentEntity) {
        await addToFolder(currentEntity, element, newIndex);
      }
    }
  }
</script>

{#if isEditing}
  <div
    class={[
      "flex flex-col gap-2 w-full pb-6 min-h-10 border border-accent-400/30 dark:border-accent-900/50 rounded-xl p-1",
    ]}
    use:dragHandleZone={{
      items:
        (orderedChildren.filter((x) => x && !x?.softDeleted) as Item[]) ?? [],
      dropTargetStyle: { outline: "--var(color-accent-500) solid 2px" },
    }}
    onconsider={handleDndConsider}
    onfinalize={handleDndFinalize}
  >
    {#each orderedChildren.filter((x) => x && !x?.softDeleted) as child (child?.id)}
      <div class="flex items-start gap-1 w-full max-w-full">
        <div
          use:dragHandle
          aria-label="drag-handle for {child?.name}"
          class="mt-2"
        >
          <Icon icon="lucide:grip-vertical" class="size-4" />
        </div>

        <SidebarObject object={child} {me} bind:isEditing {editEntity} />
      </div>
    {/each}
  </div>
{:else}
  <div class={["flex flex-col gap-2 w-full"]}>
    {#each (children ?? []).filter((x) => x && !x?.softDeleted) as child (child?.id)}
      <div class="flex items-start gap-2 w-full">
        <SidebarObject object={child} {me} bind:isEditing {editEntity} />
      </div>
    {/each}
  </div>
{/if}
