<script lang="ts">
  import type { Snippet } from "svelte";
  import { buttonVariants } from "../ui/button/Button.svelte";
  import {
    ContextMenu,
    ContextMenuItem,
    ContextMenuSeparator,
  } from "../ui/context-menu/index.js";

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
    onCreateChannel,
    onCreateCategory,
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
    /** Called when "Create Channel" is clicked in the menu. Only shown when isAdmin. */
    onCreateChannel?: () => void;
    /** Called when "Create Category" is clicked in the menu. Only shown when isAdmin. */
    onCreateCategory?: () => void;
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

  let menuOpen = $state(false);
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

  <ContextMenu
    bind:open={menuOpen}
    side="bottom"
    align="center"
    sideOffset={10}
  >
    {#snippet trigger({ props: { action, ...attrs } })}
      <button
        use:action
        {...attrs}
        class={buttonVariants({ variant: "ghost", size: "iconSm" })}
        aria-label="Space menu"
      >
        <IconEllipsisHorizontal class="size-4" />
      </button>
    {/snippet}

    {#if showInviteButton}
      <ContextMenuItem onSelect={() => { onInvite(); }}>
        <IconShare class="size-4" />
        Invite
      </ContextMenuItem>
    {/if}

    {#if isAdmin}
      {#if showInviteButton}
        <ContextMenuSeparator />
      {/if}

      <ContextMenuItem onSelect={() => { isEditing = !isEditing; }}>
        <IconPencil class="size-4" />
        {isEditing ? "Finish editing" : "Edit Sidebar"}
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={() => { onCreateChannel?.(); }}>
        <IconPlus class="size-4" />
        Create Channel
      </ContextMenuItem>

      <ContextMenuItem onSelect={() => { onCreateCategory?.(); }}>
        <IconPlus class="size-4" />
        Create Category
      </ContextMenuItem>

      {#if settingsHref}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => { window.location.href = settingsHref; }}>
          <IconSettings class="size-4" />
          Space settings
        </ContextMenuItem>
      {/if}
    {/if}

    <ContextMenuSeparator />

    <ContextMenuItem variant="danger" onSelect={() => { onLeave(); }}>
      <IconLogOut class="size-4" />
      Leave Space
    </ContextMenuItem>
  </ContextMenu>
</div>
