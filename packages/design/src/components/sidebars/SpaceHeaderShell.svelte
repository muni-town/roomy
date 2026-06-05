<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "../ui/button/Button.svelte";
  import Popover from "../ui/popover/Popover.svelte";

  import {
    IconEllipsisHorizontal,
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
    onSpacePicker,
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
    /** Called when clicking the space name/avatar to open the space picker. */
    onSpacePicker?: () => void;
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
  <!-- Clickable header area – opens space picker -->
  <button
    onclick={onSpacePicker}
    class="flex items-center gap-2 mt-2 hover:bg-accent-200/70 dark:hover:bg-base-900/70 cursor-pointer rounded-2xl p-2 flex-1 min-w-0 text-left transition-colors"
  >
    {@render avatar()}

    <h1
      class="text-md font-semibold text-base-900 dark:text-base-100 truncate max-w-full grow min-w-0"
    >
      {spaceName ?? ""}
    </h1>
  </button>

  <Popover
    side="bottom"
    align="end"
    bind:open={popoverOpen}
    sideOffset={5}
  >
    {#snippet child({ props })}
      <button
        {...props}
        class="shrink-0 mt-2 flex items-center justify-center size-8 rounded-full hover:bg-accent-200/70 dark:hover:bg-base-900/70 text-base-400 hover:text-base-600 dark:hover:text-base-300 transition-colors cursor-pointer"
        aria-label="Space menu"
      >
        <IconEllipsisHorizontal class="size-4" />
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
