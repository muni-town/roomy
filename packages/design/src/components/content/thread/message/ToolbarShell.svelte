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
    class={`${isEmojiToolbarPickerOpen ? "flex" : "flex"} shadow-lg border border-base-200 dark:border-base-300/10 backdrop-blur-sm absolute -top-4 right-0 bg-base-50 dark:bg-base-900/50 p-0.5 rounded-[12px] items-center`}
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
            class="backdrop-blur-none h-[34px]"
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
            "backdrop-blur-none h-[34px]",
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
            "backdrop-blur-none h-[34px]",
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
          "backdrop-blur-none h-[34px]",
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
          "backdrop-blur-none h-[34px]",
        ]}
        aria-label="Reply"
      >
        <IconReply />
      </Toolbar.Button>
    </Tooltip>
  </Toolbar.Root>
</BitsTooltip.Provider>
