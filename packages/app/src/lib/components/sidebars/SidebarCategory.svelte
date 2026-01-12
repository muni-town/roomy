<script lang="ts">
  import { Button } from "@fuxui/base";
  import type { SidebarCategory } from "$lib/queries";

  import IconLucidePencil from "~icons/lucide/pencil";
  import IconHeroiconsChevronDown from "~icons/heroicons/chevron-down";
  import IconHeroiconsChevronUp from "~icons/heroicons/chevron-up";
  import { page } from "$app/state";
  import SidebarItem from "./SidebarItem.svelte";

  let {
    category,
    isEditing = $bindable(false),
    editSidebarItem,
  }: {
    category: SidebarCategory;
    isEditing: boolean;
    editSidebarItem: () => void;
  } = $props();

  let showGroupChildren = $state(true);
</script>

{#snippet editButton()}
  {#if isEditing}
    <Button
      variant="ghost"
      size="icon"
      onclick={editSidebarItem}
      class="group-hover:opacity-100 opacity-0"
    >
      <IconLucidePencil class="size-4" />
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
      {#if showGroupChildren}
        <IconHeroiconsChevronDown class="shrink-0 !size-2" />
      {:else}
        <IconHeroiconsChevronUp class="shrink-0 !size-2" />
      {/if}
    </Button>
    {@render editButton?.()}
  </div>

  <!-- Group children (pages, channels) -->
  {#if showGroupChildren}
    <div class={"w-full max-w-full shrink min-w-0"}>
      {#each category.children as child, index (child.id)}
        <div class="flex items-start gap-2 w-full">
          <SidebarItem bind:isEditing {editSidebarItem} {index} item={child} />
        </div>
      {/each}
    </div>
  {/if}
</div>
