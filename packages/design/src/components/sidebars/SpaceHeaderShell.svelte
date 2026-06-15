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
    isEditing = $bindable(false),
    onNew,
    settingsHref,
    onInvite,
    onLeave,
    /**
     * Optional collapse-sidebar button rendered to the left of the space name.
     * When provided, it replaces the avatar as the clickable element next to
     * the space name.
     */
    collapseSidebar,
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
    /**
     * Optional collapse-sidebar button rendered to the left of the space name.
     * When provided, it replaces the avatar as the clickable element next to
     * the space name.
     */
    collapseSidebar?: Snippet;
  } = $props();

  let popoverOpen = $state(false);
</script>

<div
  class="w-full py-2 px-1.5 h-fit flex justify-between items-center gap-1"
>
  <!-- Header row: collapse/avatar + name + actions -->
  <div class="flex items-center gap-2 flex-1 min-w-0">
    {#if collapseSidebar}
      {@render collapseSidebar()}
    {:else}
      {@render avatar()}
    {/if}

    <h1
      class="text-md font-semibold text-base-900 dark:text-base-100 truncate max-w-full grow min-w-0"
    >
      {spaceName ?? ""}
    </h1>
  </div>

  <Popover
    side="bottom"   
    align="start"
    bind:open={popoverOpen}
    sideOffset={5}
  >
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="iconSm"
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
          variant="secondary"
          size="sm"
          class="w-full"
        >
          <IconShare /> 
          Invite
        </Button>
      {/if}

      {#if isAdmin}
        <Button
          variant="secondary"
          size="sm"
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
          <Button variant="secondary" size="sm" class="w-full" href={settingsHref}>
            <IconSettings/> Space settings
          </Button>
        {/if}
      {/if}

      <Button variant="red" size="sm" class="w-full" onclick={onLeave}>
        <IconLogOut /> Leave Space
      </Button>
    </div>
  </Popover>

  {#if isAdmin && onNew}
    <Button
      variant="secondary"
      size="iconSm"
      onclick={onNew}
      aria-label="Create new room or category"
    >
      <IconPlus />
    </Button>
  {/if}
</div>
