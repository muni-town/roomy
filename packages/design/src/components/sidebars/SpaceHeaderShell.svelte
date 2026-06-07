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
  class="w-full py-2 px-1.5 h-fit flex justify-between items-center gap-1"
>
  <!-- Clickable header area – opens space picker -->
  <button
    onclick={onSpacePicker}
    class="flex items-center gap-2 hover:bg-accent-200/70 dark:hover:bg-base-900/70 cursor-pointer rounded-2xl p-2 flex-1 min-w-0 text-left transition-colors"
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
    align="start"
    bind:open={popoverOpen}
    sideOffset={5}
  >
    {#snippet child({ props })}
      <Button
        {...props}
        variant="primary"
        class="p-2"
        aria-label="Space menu"
      >
        <IconEllipsisHorizontal class="size-4" />
      </Button>
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
          <IconShare /> 
          Invite
        </Button>
      {/if}

      {#if isAdmin}
        <Button
          variant="secondary"
          class="w-full"
          onclick={() => {
            isEditing = !isEditing;
            popoverOpen = false;
          }}
        >
          <IconPencil/>
          {isEditing ? "Finish editing" : "Edit Sidebar"}
        </Button>

        {#if settingsHref}
          <Button variant="secondary" class="w-full" href={settingsHref}>
            <IconSettings/> Space settings
          </Button>
        {/if}
      {/if}

      <Button variant="red" class="w-full" onclick={onLeave}>
        <IconLogOut /> Leave Space
      </Button>
    </div>
  </Popover>

  {#if isAdmin && onNew}
    <Button
      variant="secondary"
      class="p-2"
      onclick={onNew}
      aria-label="Create new room or category"
    >
      <IconPlus />
    </Button>
  {/if}
</div>
