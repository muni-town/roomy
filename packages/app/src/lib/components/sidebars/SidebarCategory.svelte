<script lang="ts">
  import { Button } from "@fuxui/base";
  import type { SidebarCategory } from "$lib/queries";
  import { dragHandleZone, dragHandle } from "svelte-dnd-action";
  import { IconPencil, IconChevronDown, IconChevronUp, IconGripVertical } from "@roomy/design/icons";
  import { page } from "$app/state";
  import SidebarItem from "./SidebarItem.svelte";
  import type { Ulid } from "@roomy/sdk";

  let {
    category,
    isEditing = $bindable(false),
    editSidebarItem,
    onRoomMove,
  }: {
    category: SidebarCategory;
    isEditing: boolean;
    editSidebarItem: (id: { room: Ulid } | { category: string }) => void;
    onRoomMove?: (newChildren: SidebarCategory["children"]) => void;
  } = $props();

  // Local state just for visual feedback during drag
  let draggingChildren = $state<typeof category.children | null>(null);
  const displayChildren = $derived(draggingChildren ?? category.children ?? []);

  let showGroupChildren = $state(true);
</script>

{#snippet editButton()}
  {#if isEditing}
    <Button
      variant="ghost"
      size="icon"
      onclick={() => editSidebarItem({ category: category.id })}
      class="group-hover:opacity-100 opacity-20"
    >
      <IconPencil class="size-4" />
    </Button>
  {/if}
{/snippet}

<div class="inline-flex min-w-0 flex-col gap-1 w-full max-w-full shrink pb-4">
  <div
    class="inline-flex items-start justify-between gap-2 w-full shrink group"
  >
    <Button
      variant="ghost"
      class="w-full shrink min-w-0 justify-start hover:bg-transparent hover:text-base-900 dark:hover:bg-transparent dark:hover:text-base-100 hover:cursor-default active:scale-100"
      data-current={category.id === page.params.object && !isEditing}
      onclick={() => {
        showGroupChildren = !showGroupChildren;
      }}
    >
      <span
        class="truncate font-regular text-base-600 dark:text-base-400 text-xs tracking-wide whitespace-nowrap overflow-hidden min-w-0"
        >{category.name}</span
      >
      {#if !isEditing}
        {#if showGroupChildren}
          <IconChevronDown class="shrink-0 !size-2" />
        {:else}
          <IconChevronUp class="shrink-0 !size-2" />
        {/if}
      {/if}
    </Button>
    {@render editButton?.()}
  </div>

  <!-- Group children (pages, channels) -->
  {#if isEditing}
    <div
      class="w-full max-w-full shrink min-w-0 min-h-4 p-1"
      use:dragHandleZone={{
        items: displayChildren,
        type: "room",
        flipDurationMs: 150,
        dropTargetClasses: ["min-h-10", "bg-accent-500/10", "rounded"],
        dropTargetStyle: {
          outline: "2px solid var(--color-accent-500/30)",
        },
      }}
      onconsider={(e) => (draggingChildren = e.detail.items)}
      onfinalize={(e) => {
        draggingChildren = null;
        onRoomMove?.(e.detail.items);
      }}
    >
      {#each displayChildren as room, index (room.id)}
        <div id={room.id} class="flex items-start w-full relative">
          <div
            class="mt-[10px]"
            use:dragHandle
            aria-label="drag handle for {room.name}"
          >
            <IconGripVertical class="size-3" />
          </div>
          <SidebarItem bind:isEditing {editSidebarItem} {index} item={room} />
        </div>
      {/each}
    </div>
  {:else if showGroupChildren}
    <div class="w-full max-w-full shrink min-w-0 min-h-4 p-1">
      {#each category.children as room, index (room.id)}
        <div id={room.id} class="flex items-start w-full relative">
          <SidebarItem bind:isEditing {editSidebarItem} {index} item={room} />
        </div>
      {/each}
    </div>
  {/if}
</div>
