<script lang="ts" generics="T extends { id: string; name: string }">
  import type { Snippet } from "svelte";
  import Button from "../ui/button/Button.svelte";
  import { dragHandleZone, dragHandle } from "svelte-dnd-action";
  import {
    IconPencil,
    IconChevronDown,
    IconChevronUp,
    IconGripVertical,
  } from "../../icons/index";

  let {
    name,
    items,
    isEditing,
    active = false,
    onEditCategory,
    onItemsReorder,
    item,
  }: {
    name: string;
    items: T[];
    isEditing: boolean;
    /** Whether the category itself is the active route target. */
    active?: boolean;
    /** Called when the edit (pencil) button is clicked. */
    onEditCategory?: () => void;
    /** Called when the user finalizes a drag-reorder. */
    onItemsReorder?: (newItems: T[]) => void;
    /** Per-child renderer. Index is passed for callers that need it. */
    item: Snippet<[T, number]>;
  } = $props();

  let draggingChildren = $state<T[] | null>(null);
  const displayChildren = $derived(draggingChildren ?? items ?? []);

  let showGroupChildren = $state(true);
</script>

<div class="inline-flex min-w-0 flex-col w-full max-w-full shrink pb-4">
  <div
    class="inline-flex items-start justify-between gap-2 w-full shrink group"
  >
    <Button
      variant="ghost"
      class="w-full shrink min-w-0 justify-start hover:cursor-default text-base-600 dark:text-base-400 "
      data-current={active && !isEditing}
      onclick={() => {
        showGroupChildren = !showGroupChildren;
      }}
    >
      <span
        class="truncate font-regular text-xs tracking-wide whitespace-nowrap overflow-hidden min-w-0"
        >{name}</span
      >
      {#if !isEditing}
        {#if showGroupChildren}
          <IconChevronDown class="shrink-0 size-3!" />
        {:else}
          <IconChevronDown class="shrink-0 size-3! -rotate-90" />
        {/if}
      {/if}
    </Button>
    {#if isEditing && onEditCategory}
      <Button
        variant="ghost"
        size="icon"
        onclick={onEditCategory}
        class="group-hover:opacity-100 opacity-20"
      >
        <IconPencil class="size-4" />
      </Button>
    {/if}
  </div>

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
      onconsider={(e) => (draggingChildren = e.detail.items as T[])}
      onfinalize={(e) => {
        draggingChildren = null;
        onItemsReorder?.(e.detail.items as T[]);
      }}
    >
      {#each displayChildren as child, index (child.id)}
        <div id={child.id} class="flex items-start w-full relative">
          <div
            class="mt-2.5"
            use:dragHandle
            aria-label="drag handle for {child.name}"
          >
            <IconGripVertical class="size-3" />
          </div>
          {@render item(child, index)}
        </div>
      {/each}
    </div>
  {:else if showGroupChildren}
    <div class="w-full max-w-full shrink min-w-0 min-h-4 p-1 space-y-[1px]">
      {#each items as child, index (child.id)}
        <div id={child.id} class="flex items-start w-full relative">
          {@render item(child, index)}
        </div>
      {/each}
    </div>
  {/if}
</div>
