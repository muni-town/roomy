<script lang="ts">
  import Drawer from "../../../helper/Drawer.svelte";
  import Button from "../../../ui/button/Button.svelte";
  import { PopoverEmojiPicker } from "@foxui/social";
  import {
    IconSmilePlus,
    IconReply,
    IconForward,
    IconNeedleThread,
    IconEdit,
    IconTrash,
  } from "../../../../icons/index";

  let {
    visible,
    open = $bindable(false),
    canEdit,
    canDelete,
    onToggleReaction,
    onReply,
    onForward,
    onStartThreading,
    onEdit,
    onDelete,
  }: {
    /** Whether there is a target message — when false the action area is empty. */
    visible: boolean;
    open: boolean;
    /** Author-only — shows the Edit action. */
    canEdit: boolean;
    /** Author or space admin — shows the Delete action. */
    canDelete: boolean;
    onToggleReaction: (emoji: string) => void;
    onReply: () => void;
    onForward: () => void;
    onStartThreading: () => void;
    onEdit: () => void;
    onDelete: () => void;
  } = $props();

  let isEmojiPickerOpen = $state(false);

  function handlePick(emoji: string) {
    onToggleReaction(emoji);
    isEmojiPickerOpen = false;
    open = false;
  }

  function handleQuickReact(emoji: string) {
    onToggleReaction(emoji);
    open = false;
  }
</script>

<Drawer
  bind:open
  onOutsideClick={(e) => {
    if (isEmojiPickerOpen) e.preventDefault();
  }}
>
  {#if visible}
    <div class="flex gap-4 justify-center mb-4">
      <Button
        variant="ghost"
        size="icon"
        onclick={() => handleQuickReact("👍")}
        class="dz-btn dz-btn-circle"
      >
        👍
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onclick={() => handleQuickReact("😂")}
      >
        😂
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onclick={() => handleQuickReact("❤️")}
      >
        ❤️
      </Button>

      <PopoverEmojiPicker
        bind:open={isEmojiPickerOpen}
        onpicked={(emoji) => handlePick(emoji.unicode)}
        interactOutsideBehavior="close"
        search
        favorites
      >
        {#snippet child({ props })}
          <Button size="icon" variant="ghost" {...props}>
            <IconSmilePlus class="text-primary" />
          </Button>
        {/snippet}
      </PopoverEmojiPicker>
    </div>

    <div class="flex flex-col gap-4 w-full">
      <Button
        onclick={() => {
          onReply();
          open = false;
        }}
        class="dz-join-item dz-btn w-full"
      >
        <IconReply />
        Reply
      </Button>
      <Button
        onclick={() => {
          onForward();
          open = false;
        }}
        class="dz-join-item dz-btn w-full"
      >
        <IconForward />
        Forward
      </Button>
      <Button
        onclick={() => {
          onStartThreading();
          open = false;
        }}
        class="dz-join-item dz-btn w-full"
      >
        <IconNeedleThread />Create Thread
      </Button>
      {#if canEdit}
        <Button
          onclick={() => {
            onEdit();
            open = false;
          }}
          class="dz-join-item dz-btn w-full"
        >
          <IconEdit />
          Edit
        </Button>
      {/if}
      {#if canDelete}
        <Button
          onclick={() => {
            onDelete();
            open = false;
          }}
          class="dz-join-item dz-btn dz-btn-error w-full"
        >
          <IconTrash />
          Delete
        </Button>
      {/if}
    </div>
  {/if}
</Drawer>
