<script lang="ts">
  import { Toolbar, Tooltip as BitsTooltip } from "bits-ui";
  import Tooltip from "../../../helper/Tooltip.svelte";
  import Button, { buttonVariants } from "../../../ui/button/Button.svelte";
  import { PopoverEmojiPicker } from "@foxui/social";
  import {
    IconSmilePlus,
    IconReply,
    IconNeedleThread,
    IconEdit,
    IconTrash,
  } from "../../../../icons/index";

  let {
    canEditDelete,
    keepToolbarOpen = $bindable(false),
    onToggleReaction,
    onEdit,
    onDelete,
    onStartThreading,
    onReply,
  }: {
    canEditDelete: boolean;
    /** Bindable — kept open while the emoji picker is open. */
    keepToolbarOpen?: boolean;
    onToggleReaction: (emoji: string) => void;
    onEdit: () => void;
    onDelete: () => void;
    onStartThreading: () => void;
    onReply: () => void;
  } = $props();

  let isEmojiToolbarPickerOpen = $state(false);

  $effect(() => {
    keepToolbarOpen = isEmojiToolbarPickerOpen;
  });

  function handlePick(emoji: string) {
    onToggleReaction(emoji);
    isEmojiToolbarPickerOpen = false;
  }
</script>

<BitsTooltip.Provider>
  <Toolbar.Root
    class={`${isEmojiToolbarPickerOpen ? "flex" : "hidden"} group-hover:flex shadow-lg border border-base-800/5 dark:border-base-300/10 backdrop-blur-sm absolute -top-4 right-2 bg-base-100/80 dark:bg-base-800/70 p-px rounded-xl items-center`}
    onclick={(e) => e.stopPropagation()}
  >
    <Toolbar.Button
      onclick={() => onToggleReaction("👍")}
      class={[
        buttonVariants({ variant: "ghost", size: "iconSm" }),
        "backdrop-blur-none text-lg",
      ]}
    >
      👍
    </Toolbar.Button>
    <Toolbar.Button
      onclick={() => onToggleReaction("😂")}
      class={[
        buttonVariants({ variant: "ghost", size: "iconSm" }),
        "backdrop-blur-none text-lg",
      ]}
    >
      😂
    </Toolbar.Button>

    <Tooltip tip="Pick an Emoji">
      <PopoverEmojiPicker
        bind:open={isEmojiToolbarPickerOpen}
        onpicked={(emoji) => handlePick(emoji.unicode)}
      >
        {#snippet child({ props })}
          <Button
            {...props}
            size="icon"
            variant="ghost"
            class="backdrop-blur-none"
            aria-label="Pick an emoji"
          >
            <IconSmilePlus class="text-primary text-lg" />
          </Button>
        {/snippet}
      </PopoverEmojiPicker>
    </Tooltip>

    {#if canEditDelete}
      <Tooltip tip="Edit Message">
        <Toolbar.Button
          onclick={onEdit}
          class={[
            buttonVariants({ variant: "ghost", size: "icon" }),
            "backdrop-blur-none",
          ]}
          aria-label="Edit Message"
        >
          <IconEdit />
        </Toolbar.Button>
      </Tooltip>

      <Tooltip tip="Delete Message">
        <Toolbar.Button
          onclick={onDelete}
          class={[
            buttonVariants({ variant: "ghost", size: "icon" }),
            "backdrop-blur-none",
          ]}
          aria-label="Delete Message"
        >
          <IconTrash class="text-warning" />
        </Toolbar.Button>
      </Tooltip>
    {/if}

    <Tooltip tip="Create Thread">
      <Toolbar.Button
        onclick={onStartThreading}
        class={[
          buttonVariants({ variant: "ghost", size: "icon" }),
          "backdrop-blur-none",
        ]}
        aria-label="Create Thread"
      >
        <IconNeedleThread class="text-primary" />
      </Toolbar.Button>
    </Tooltip>

    <Tooltip tip="Reply">
      <Toolbar.Button
        onclick={onReply}
        class={[
          buttonVariants({ variant: "ghost", size: "icon" }),
          "backdrop-blur-none",
        ]}
        aria-label="Reply"
      >
        <IconReply />
      </Toolbar.Button>
    </Tooltip>
  </Toolbar.Root>
</BitsTooltip.Provider>
