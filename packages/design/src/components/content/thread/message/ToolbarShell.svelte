<script lang="ts">
  import { Toolbar, Tooltip as BitsTooltip } from "bits-ui";
  import Tooltip from "../../../helper/Tooltip.svelte";
  import Button, { buttonVariants } from "../../../ui/button/Button.svelte";
  import ContextMenu from "../../../ui/context-menu/ContextMenu.svelte";
  import ContextMenuItem from "../../../ui/context-menu/ContextMenuItem.svelte";
  import { PopoverEmojiPicker } from "@foxui/social";
  import {
    IconSmilePlus,
    IconReply,
    IconForward,
    IconNeedleThread,
    IconEdit,
    IconTrash,
    IconEllipsisHorizontal,
    IconCheckSquare,
  } from "../../../../icons/index";

  let {
    canEdit,
    canDelete,
    mergeWithPrevious = false,
    keepToolbarOpen = $bindable(false),
    onToggleReaction,
    onEdit,
    onDelete,
    onStartThreading,
    onSelect,
    onReply,
    onForward,
  }: {
    /** Author-only — shows the Edit button. */
    canEdit: boolean;
    /** Author or space admin — shows the Delete button. */
    canDelete: boolean;
    /** Whether this is a message sharing the previous message's author and timestamp row. */
    mergeWithPrevious?: boolean;
    /** Bindable — kept open while the emoji picker is open. */
    keepToolbarOpen?: boolean;
    onToggleReaction: (emoji: string) => void;
    onEdit: () => void;
    onDelete: () => void;
    onStartThreading: () => void;
    /** Enters multi-select mode for this message. */
    onSelect: () => void;
    onReply: () => void;
    onForward: () => void;
  } = $props();

  let isEmojiToolbarPickerOpen = $state(false);
  let isActionMenuOpen = $state(false);

  $effect(() => {
    // The context menu portals to `body`, so leaving the message row fires
    // `mouseleave` and would hide the toolbar (unmounting the menu) while it
    // is open. Keep the toolbar mounted for the lifetime of either popover.
    keepToolbarOpen = isEmojiToolbarPickerOpen || isActionMenuOpen;
  });

  function handlePick(emoji: string) {
    onToggleReaction(emoji);
    isEmojiToolbarPickerOpen = false;
  }
</script>

<BitsTooltip.Provider>
  <Toolbar.Root
    class={`${isEmojiToolbarPickerOpen ? "flex" : "flex"} shadow-lg border border-base-200 dark:border-base-300/10 backdrop-blur-sm absolute ${mergeWithPrevious ? "-top-9" : "-top-4"} right-0 bg-base-50 dark:bg-base-900/50 p-0.5 rounded-[12px] items-center`}
    onclick={(e) => e.stopPropagation()}
  >
    <Toolbar.Button
      onclick={() => onToggleReaction("👍")}
      class={[
        buttonVariants({ variant: "ghost", size: "iconSm" }),
        "backdrop-blur-none h-[34px]",
      ]}
    >
      👍
    </Toolbar.Button>
    <Toolbar.Button
      onclick={() => onToggleReaction("😂")}
      class={[
        buttonVariants({ variant: "ghost", size: "iconSm" }),
        "backdrop-blur-none h-[34px]",
      ]}
    >
      😂
    </Toolbar.Button>
    <Toolbar.Button
      onclick={() => onToggleReaction("❤️")}
      class={[
        buttonVariants({ variant: "ghost", size: "iconSm" }),
        "backdrop-blur-none h-[34px]",
      ]}
    >
      ❤️
    </Toolbar.Button>

    <Tooltip tip="Pick an Emoji">
      <PopoverEmojiPicker
        bind:open={isEmojiToolbarPickerOpen}
        onpicked={(emoji) => handlePick(emoji.unicode)}
        search
        favorites
      >
        {#snippet child({ props })}
          <Button
            {...props}
            size="icon"
            variant="ghost"
            class="backdrop-blur-none h-[34px]"
            aria-label="Pick an emoji"
          >
            <IconSmilePlus class="text-primary text-lg" />
          </Button>
        {/snippet}
      </PopoverEmojiPicker>
    </Tooltip>

    <Tooltip tip="Reply">
      <Toolbar.Button
        onclick={onReply}
        class={[
          buttonVariants({ variant: "ghost", size: "icon" }),
          "backdrop-blur-none h-[34px]",
        ]}
        aria-label="Reply"
      >
        <IconReply />
      </Toolbar.Button>
    </Tooltip>

    <Tooltip tip="Forward">
      <Toolbar.Button
        onclick={onForward}
        class={[
          buttonVariants({ variant: "ghost", size: "icon" }),
          "backdrop-blur-none h-[34px]",
        ]}
        aria-label="Forward"
      >
        <IconForward />
      </Toolbar.Button>
    </Tooltip>

    <ContextMenu side="bottom" align="end" sideOffset={8} bind:open={isActionMenuOpen}>
      {#snippet trigger({ props })}
        <Toolbar.Button
          {...props}
          class={[
            buttonVariants({ variant: "ghost", size: "icon" }),
            "backdrop-blur-none h-[34px]",
          ]}
          aria-label="More actions"
        >
          <IconEllipsisHorizontal />
        </Toolbar.Button>
      {/snippet}

      {#if canEdit}
        <ContextMenuItem onclick={onEdit}>
          <IconEdit class="size-4" />
          Edit
        </ContextMenuItem>
      {/if}
      {#if canDelete}
        <ContextMenuItem variant="danger" onclick={onDelete}>
          <IconTrash class="size-4" />
          Delete
        </ContextMenuItem>
      {/if}
      <ContextMenuItem onclick={onForward}>
        <IconForward class="size-4" />
        Forward
      </ContextMenuItem>
      <ContextMenuItem onclick={onStartThreading}>
        <IconNeedleThread class="size-4" />
        Create Thread
      </ContextMenuItem>
      <ContextMenuItem onclick={onSelect}>
        <IconCheckSquare class="size-4" />
        Select
      </ContextMenuItem>
    </ContextMenu>
  </Toolbar.Root>
</BitsTooltip.Provider>
