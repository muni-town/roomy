<script lang="ts">
  import type { Snippet } from "svelte";

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
     * Whether the space selector (server bar) is currently open. Used for the
     * aria-expanded state and tooltip of the header toggle button.
     */
    spaceSelectorOpen = false,
    /**
     * When provided, the space header (avatar + name) becomes a button that
     * opens/closes the space selector. When omitted, the header is static.
     */
    onToggleSpaceSelector,
  }: {
    spaceName?: string;
    /** Avatar rendered by caller (e.g. SpaceAvatar wrapper) */
    avatar: Snippet;
    isAdmin: boolean;
    showInviteButton?: boolean;
    isEditing?: boolean;
    /** Called when "Create Channel" is clicked in the menu. Only shown when isAdmin. */
    onCreateChannel?: () => void;
    /** Called when "Create Category" is clicked in the menu. Only shown when isAdmin. */
    onCreateCategory?: () => void;
    /** Href for the "Space settings" admin action */
    settingsHref?: string;
    /** Called when Invite button is clicked. Wrapper decides between copy-link vs open modal. */
    onInvite?: () => void;
    /** Called when Leave Space is clicked. */
    onLeave?: () => void;
    /**
     * Whether the space selector (server bar) is currently open. Used for the
     * aria-expanded state and tooltip of the header toggle button.
     */
    spaceSelectorOpen?: boolean;
    /**
     * When provided, the space header (avatar + name) becomes a button that
     * opens/closes the space selector. When omitted, the header is static.
     */
    onToggleSpaceSelector?: () => void;
  } = $props();
</script>

<div
  class="w-full h-fit flex justify-between items-center gap-1"
>
  <!-- Header row: avatar + name (clickable to toggle the space selector) -->
  <div class="flex items-center gap-2 flex-1 min-w-0">
    {#if onToggleSpaceSelector}
      <button
        type="button"
        onclick={onToggleSpaceSelector}
        class="flex items-center gap-2.75 flex-1 min-w-0 -mx-1 px-5.5 py-3 hover:bg-base-200/20 dark:hover:bg-base-900/30 transition-colors cursor-pointer text-left"
        aria-label="Toggle space selector"
        aria-expanded={spaceSelectorOpen}
        title={spaceSelectorOpen ? "Hide space selector" : "Show space selector"}
      >
        {@render avatar?.()}
        <h1
          class="text-md font-semibold text-base-900 dark:text-base-100 truncate max-w-full grow min-w-0"
        >
          {spaceName ?? ""}
        </h1>
      </button>
    {:else}
      {@render avatar?.()}
      <h1
        class="text-md font-semibold text-base-900 dark:text-base-100 truncate max-w-full grow min-w-0"
      >
        {spaceName ?? ""}
      </h1>
    {/if}
  </div>
</div>
