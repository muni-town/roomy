<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "@foxui/core";
  import Button from "../ui/button/Button.svelte";
  import Popover from "../ui/popover/Popover.svelte";

  import {
    IconChevronDown,
    IconShare,
    IconPlus,
    IconPencil,
    IconSettings,
    IconLogOut,
  } from "../../icons/index";

  let {
    spaceName,
    avatar,
    isAdmin,
    showInviteButton,
    isEditing = $bindable(false),
    onNew,
    settingsHref,
    onInvite,
    onLeave,
  }: {
    spaceName?: string;
    /** Avatar rendered by caller (e.g. SpaceAvatar wrapper) */
    avatar: Snippet;
    isAdmin: boolean;
    showInviteButton: boolean;
    isEditing?: boolean;
    /** Called when the "+" button is clicked to create a room or category. Only shown when isAdmin. */
    onNew?: () => void;
    /** Href for the "Space settings" admin action */
    settingsHref?: string;
    /** Called when Invite button is clicked. Wrapper decides between copy-link vs open modal. */
    onInvite: () => void;
    /** Called when Leave Space is clicked. */
    onLeave: () => void;
  } = $props();

  let popoverOpen = $state(false);
</script>

<div
  class="w-full pt-0.5 pb-1 px-2 h-fit flex mb-4 justify-between items-center gap-1"
>
  <Popover
    side="bottom"
    class="grow"
    align="end"
    bind:open={popoverOpen}
    sideOffset={5}
  >
    {#snippet child({ props })}
      <button
        {...props}
        class="flex justify-between items-center mt-2 hover:bg-accent-200/70 dark:hover:bg-base-900/70 cursor-pointer rounded-2xl p-2 w-full text-left transition-colors"
      >
        <div class="flex items-center gap-4 max-w-full min-w-0">
          {@render avatar()}

          <h1
            class="text-md font-semibold text-base-900 dark:text-base-100 truncate max-w-full grow min-w-0"
          >
            {spaceName ?? ""}
          </h1>
        </div>
        <IconChevronDown
          class={cn(
            "size-4 text-base-700 dark:text-base-300 transition-transform duration-200 shrink-0",
            popoverOpen && "rotate-180",
          )}
        />
      </button>
    {/snippet}
    <div class="flex flex-col items-start justify-stretch gap-2 w-[204px]">
      {#if showInviteButton}
        <Button
          onclick={() => {
            onInvite();
            popoverOpen = false;
          }}
          class="w-full"
        >
          <IconShare class="size-4" /> Invite
        </Button>
      {/if}

      {#if isAdmin}
        <Button
          class="w-full"
          onclick={() => {
            isEditing = !isEditing;
            popoverOpen = false;
          }}
          variant="secondary"
        >
          <IconPencil class="size-4" />
          {isEditing ? "Finish editing" : "Edit Sidebar"}
        </Button>

        {#if settingsHref}
          <Button class="w-full" href={settingsHref} variant="secondary">
            <IconSettings class="size-4" /> Space settings
          </Button>
        {/if}
      {/if}

      <Button variant="red" class="w-full" onclick={onLeave}>
        <IconLogOut class="size-4" /> Leave Space
      </Button>
    </div>
  </Popover>

  {#if isAdmin && onNew}
    <button
      onclick={onNew}
      class="shrink-0 mt-2 flex items-center justify-center size-8 rounded-full hover:bg-accent-200/70 dark:hover:bg-base-900/70 text-base-500 hover:text-accent-600 dark:hover:text-accent-400 transition-colors cursor-pointer"
      aria-label="Create new room or category"
    >
      <IconPlus class="size-4" />
    </button>
  {/if}
</div>
