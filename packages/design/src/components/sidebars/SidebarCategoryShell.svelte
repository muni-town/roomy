<script lang="ts" generics="T extends { id: string; name?: string }">
  import type { Snippet } from "svelte";
  import Button from "../ui/button/Button.svelte";
  import { dragHandleZone, dragHandle } from "svelte-dnd-action";
  import {
    IconSettings,
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
    /** Called when the edit (gear) button is clicked. */
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

<div class="inline-flex min-w-0 flex-col w-full max-w-full shrink">
  <div
    class="inline-flex items-center justify-between gap-2 w-full shrink group mt-2"
  >
    <Button
      variant="ghost"
      class={[
        "w-full shrink min-w-0 justify-start px-2 pt-1 pb-1 text-base-400 dark:text-base-500",
        isEditing
          ? "hover:cursor-pointer hover:bg-transparent dark:hover:bg-transparent hover:border-transparent"
          : "hover:cursor-default",
      ]}
      data-current={active && !isEditing}
      onclick={() => {
        if (isEditing) {
          onEditCategory?.();
        } else {
          showGroupChildren = !showGroupChildren;
        }
      }}
    >
      <span
        class="truncate font-semibold text-[11px] uppercase tracking-wider whitespace-nowrap overflow-hidden min-w-0"
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
      <button
        type="button"
        onclick={onEditCategory}
        aria-label="Edit category"
        class="shrink-0 p-1 text-base-400 dark:text-base-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-hover:text-base-600 sm:group-hover:dark:text-base-300 cursor-pointer"
      >
        <IconSettings class="size-4" />
      </button>
    {/if}
  </div>

  {#if isEditing}
    <div
      class="w-full max-w-full shrink min-w-0 min-h-4"
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
            class="absolute -left-1 top-2.5 z-10 text-base-400 dark:text-base-500 cursor-grab"
            use:dragHandle
            aria-label="drag handle for {child.name ?? child.id}"
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
