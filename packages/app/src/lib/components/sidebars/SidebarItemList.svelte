<script lang="ts">
  // import SidebarObject from "./SidebarObject.svelte";
  // import {
  //   TRIGGERS,
  //   dragHandleZone,
  //   dragHandle,
  //   type Item,
  // } from "svelte-dnd-action";
  import { type SidebarItem } from "$lib/queries";
  import SidebarItem from "./SidebarItem.svelte";

  let {
    isEditing = $bindable(false),
    items,
    level = 0,
  }: { isEditing: boolean; items: SidebarItem[]; level?: number } = $props();

  let uncategorized: SidebarItem[] = $derived(
    items.filter((x) => x.type !== "space.roomy.category"),
  );
  let categories: SidebarItem[] = $derived(
    items.filter((x) => x.type == "space.roomy.category"),
  );

  // let {
  //   // children,
  //   // me,
  //   // isEditing = $bindable(false),
  //   // editEntity,
  //   // currentEntity,
  //   // space,
  //   // level = 0,
  //   // subthreads,
  // }: {
  //   // children: co.loaded<typeof ChildrenComponent> | undefined | null;
  //   // me: co.loaded<typeof RoomyAccount> | undefined | null;
  //   // isEditing?: boolean;
  //   // editEntity?: (entity: co.loaded<typeof RoomyEntity>) => void;
  //   // currentEntity?: co.loaded<typeof RoomyEntity> | undefined | null;
  //   // space: co.loaded<typeof RoomyEntity> | undefined | null;
  //   // level?: number;
  //   // subthreads?: co.loaded<typeof SubThreadsComponent> | undefined | null;
  // } = $props();

  // let recentSubthreads = $derived.by(() => {
  //   const subthreadsIter = Object.values(subthreads?.perAccount || {})
  //     .map((x) => [...x.all])
  //     .flat();
  //   let array = [];
  //   if (!subthreadsIter) return [];
  //   for (const subthread of subthreadsIter) {
  //     array.push(subthread.value);
  //   }
  //   return array;
  // });

  // let orderedChildren = $derived(children ?? []);

  // function handleDndConsider(e: CustomEvent) {
  //   orderedChildren = e.detail.items.filter((x: any) => x && !x?.softDeleted);
  // }
  // async function handleDndFinalize(e: CustomEvent) {
  //   console.log("finalize", e);

  //   const elementId = e.detail.info.id;
  //   const element = await RoomyEntity.load(elementId, {
  //     resolve: {
  //       components: {
  //         $each: true,
  //         $onError: null,
  //       },
  //     },
  //   });

  //   if (e.detail.info.trigger === TRIGGERS.DROPPED_INTO_ANOTHER) {
  //     if (element && currentEntity) {
  //       await removeFromFolder(currentEntity, element);
  //     }
  //   } else if (e.detail.info.trigger === TRIGGERS.DROPPED_INTO_ZONE) {
  //     if (element && currentEntity) {
  //       await removeFromFolder(currentEntity, element);
  //     }
  //     // find new index
  //     const newIndex = e.detail.items.findIndex((x: any) => x.id === elementId);
  //     // add to folder
  //     if (element && currentEntity) {
  //       await addToFolder(currentEntity, element, newIndex);
  //     }
  //   }
  // }
</script>

<!-- 
{#if isEditing}
  <div
    class={[
      "flex flex-col w-full pb-6 min-h-10 flex-1 max-w-full rounded-xl p-px",
      level > 0 ? "bg-base-400/10 dark:bg-base-900/20 py-1 -ml-2 pl-2" : "",
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
            "z-10 ",
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
{:else} -->
<!-- {#if subthreads && me}
    <div class="flex flex-col w-full pl-3 rounded-full">
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
  {/if} -->

<div class="flex flex-col w-full">
  {#if level == 0}
    <div class="flex items-start gap-2 w-full">
      <SidebarItem
        bind:isEditing
        {level}
        item={{
          type: "space.roomy.category",
          id: "general",
          name: "General",
          lastRead: 0,
          latestEntity: 0,
          unreadCount: 0,
          children: uncategorized as any,
        }}
      />
    </div>

    {#each categories as item, index (item.id)}
      <div class="flex items-start gap-2 w-full">
        <SidebarItem bind:isEditing {level} {index} {item} />
      </div>
    {/each}
  {:else}
    {#each items as item, index (item.id)}
      <div class="flex items-start gap-2 w-full">
        <SidebarItem bind:isEditing {level} {index} {item} />
      </div>
    {/each}
  {/if}
</div>
<!-- {/if} -->
