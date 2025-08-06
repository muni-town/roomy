<script lang="ts">
  import type { co } from "jazz-tools";
  import SidebarObject from "./SidebarObject.svelte";
  import {
    addToFolder,
    ChildrenComponent,
    removeFromFolder,
    RoomyEntity,
    SubThreadsComponent,
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
    space,
    level = 0,
    subthreads,
  }: {
    children: co.loaded<typeof ChildrenComponent.schema> | undefined | null;
    me: co.loaded<typeof RoomyAccount> | undefined | null;
    isEditing?: boolean;
    editEntity?: (entity: co.loaded<typeof RoomyEntity>) => void;
    currentEntity?: co.loaded<typeof RoomyEntity> | undefined | null;
    space: co.loaded<typeof RoomyEntity> | undefined | null;
    level?: number;
    subthreads?:
      | co.loaded<typeof SubThreadsComponent.schema>
      | undefined
      | null;
  } = $props();

  let recentSubthreads = $derived.by(() => {
    console.log("I want to iterate subthreads", subthreads);
    console.log("Space", space?.name);
    console.log("current entity", currentEntity?.name);
    const subthreadsIter = subthreads && me && subthreads.byMe?.all;
    console.log("subthreadsIter", subthreadsIter?.next());
    let array = [];
    if (!subthreadsIter) return [];
    for (const subthread of subthreadsIter) {
      console.log("iterated subthread", subthread.value);
      array.push(subthread.value);
    }
    return array;
  });

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
      "flex flex-col gap-2 w-full pb-6 min-h-10 flex-1 rounded-xl p-px max-w-full",
      level > 0
        ? "border border-accent-400/30 dark:border-accent-900/50 py-1"
        : "",
    ]}
    use:dragHandleZone={{
      items:
        (orderedChildren.filter((x) => x && !x?.softDeleted) as Item[]) ?? [],
      dropTargetStyle: { outline: "--var(color-accent-500) solid 2px" },
    }}
    onconsider={handleDndConsider}
    onfinalize={handleDndFinalize}
  >
    {#each orderedChildren.filter((x) => x && !x?.softDeleted) as child, index (child?.id)}
      <div class="flex items-start gap-0 w-full max-w-full min-w-0 relative">
        <div
          use:dragHandle
          aria-label="drag-handle for {child?.name}"
          class={[
            level < 1 && child?.components?.[ChildrenComponent.id] && index > 0
              ? "mt-4.5"
              : "mt-2.5",
            "absolute -left-2 top-0",
          ]}
        >
          <Icon icon="lucide:grip-vertical" class="!size-3" />
        </div>

        <SidebarObject
          object={child}
          {me}
          bind:isEditing
          {editEntity}
          {space}
          level={level + 1}
          {index}
        />
      </div>
    {/each}
  </div>
{:else}
  <!-- 
      In general, if an object has subthreads, it doesn't tend to have other children. 
      But if it does, render recent subthreads first. 
  -->
  {#if subthreads && me}
    <div class={["flex flex-col w-full pl-3 rounded-full"]}>
      {#each [...recentSubthreads.values()]
        .sort((a, b) => {
          return a && b ? a._lastUpdatedAt - b._lastUpdatedAt : -1;
        })
        .slice(-3) as subthread, index (subthread?.id)}
        <div class="flex items-start gap-2 w-full">
          <SidebarObject
            object={subthread}
            {me}
            bind:isEditing
            {editEntity}
            {space}
            level={level + 1}
            {index}
            isSubthread
          />
        </div>
      {/each}
    </div>
  {/if}
  <!-- Render regular children -->
  <div class={["flex flex-col gap-2 w-full"]}>
    {#each (children ?? []).filter((x) => x && !x?.softDeleted) as child, index (child?.id)}
      <div class="flex items-start gap-2 w-full">
        <SidebarObject
          object={child}
          {me}
          bind:isEditing
          {editEntity}
          {space}
          level={level + 1}
          {index}
        />
      </div>
    {/each}
  </div>
{/if}
