<script lang="ts">
  import { Toolbar, Tooltip as BitsTooltip } from "bits-ui";
  import Drawer from "$lib/components/helper/Drawer.svelte";
  import Tooltip from "$lib/components/helper/Tooltip.svelte";
  import { Button, buttonVariants } from "@fuxui/base";
  import { PopoverEmojiPicker } from "@fuxui/social";
  import { setReplyTo } from "../ChatInputArea.svelte";
  import type { Message } from "../ChatArea.svelte";

  import IconLucideSmilePlus from "~icons/lucide/smile-plus";
  import IconMdiReply from "~icons/mdi/reply";
  import IconTablerNeedleThread from "~icons/tabler/needle-thread";
  import IconTablerEdit from "~icons/tabler/edit";
  import IconTablerTrash from "~icons/tabler/trash";

  let {
    canEdit = true,
    canDelete = true,
    editMessage,
    deleteMessage,
    isDrawerOpen = $bindable(false),
    toggleReaction,
    message,
    startThreading,
  }: {
    canEdit?: boolean;
    canDelete?: boolean;
    editMessage: () => void;
    deleteMessage: () => void;
    toggleReaction: (reaction: string) => void;
    isDrawerOpen?: boolean;
    message: Message;
    startThreading: () => void;
  } = $props();

  let isEmojiDrawerPickerOpen = $state(false);
  let isEmojiToolbarPickerOpen = $state(false);

  function onEmojiPick(emoji: string) {
    toggleReaction(emoji);
    isEmojiToolbarPickerOpen = false;
    isEmojiDrawerPickerOpen = false;
    isDrawerOpen = false;
  }
</script>

<Drawer
  bind:open={
    () => isDrawerOpen,
    (open) => {
      if (open) {
        isDrawerOpen = open;
        return;
      }

      if (!isEmojiDrawerPickerOpen) isDrawerOpen = open;
    }
  }
>
  <div class="flex gap-4 justify-center mb-4">
    <Button
      variant="ghost"
      size="icon"
      onclick={() => {
        toggleReaction("👍");
        isDrawerOpen = false;
      }}
      class="dz-btn dz-btn-circle"
    >
      👍
    </Button>
    <Button
      variant="ghost"
      size="icon"
      onclick={() => {
        toggleReaction("😂");
        isDrawerOpen = false;
      }}
    >
      😂
    </Button>

    <PopoverEmojiPicker
      bind:open={isEmojiDrawerPickerOpen}
      onpicked={(emoji) => onEmojiPick(emoji.unicode)}
    >
      {#snippet child({ props })}
        <Button size="icon" variant="ghost" {...props}>
          <IconLucideSmilePlus class="text-primary" />
        </Button>
      {/snippet}
    </PopoverEmojiPicker>
  </div>

  <div class="flex flex-col gap-4 w-full">
    <Button
      onclick={() => {
        setReplyTo(id);
        isDrawerOpen = false;
      }}
      class="dz-join-item dz-btn w-full"
    >
      <IconMdiReply />
      Reply
    </Button>
    <Button
      onclick={() => {
        startThreading();
        isDrawerOpen = false;
      }}
      class="dz-join-item dz-btn w-full"
    >
      <IconTablerNeedleThread />Create Thread
    </Button>
    {#if canEdit}
      <Button
        onclick={() => {
          editMessage();
          isDrawerOpen = false;
        }}
        class="dz-join-item dz-btn w-full"
      >
        <IconTablerEdit />
        Edit
      </Button>
    {/if}
    {#if canDelete}
      <Button
        onclick={() => deleteMessage()}
        class="dz-join-item dz-btn dz-btn-error w-full"
      >
        <IconTablerTrash />
        Delete
      </Button>
    {/if}
  </div>
</Drawer>

<BitsTooltip.Provider>
  <Toolbar.Root
    class={`${isEmojiToolbarPickerOpen ? "flex" : "hidden"} group-hover:flex shadow-lg border border-base-800/5 dark:border-base-300/10 backdrop-blur-sm absolute -top-4 right-2 bg-base-100/80 dark:bg-base-800/70 p-1 rounded-xl items-center`}
    onclick={(e) => e.stopPropagation()}
  >
    <Toolbar.Button
      onclick={() => toggleReaction("👍")}
      class={[
        buttonVariants({ variant: "ghost", size: "iconSm" }),
        "backdrop-blur-none",
      ]}
    >
      👍
    </Toolbar.Button>
    <Toolbar.Button
      onclick={() => toggleReaction("😂")}
      class={[
        buttonVariants({ variant: "ghost", size: "iconSm" }),
        "backdrop-blur-none",
      ]}
    >
      😂
    </Toolbar.Button>

    <Tooltip tip="Pick an Emoji">
      <PopoverEmojiPicker
        bind:open={isEmojiToolbarPickerOpen}
        onpicked={(emoji) => onEmojiPick(emoji.unicode)}
      >
        {#snippet child({ props })}
          <Button
            {...props}
            size="iconSm"
            variant="ghost"
            class="backdrop-blur-none"
            aria-label="Pick an emoji"
          >
            <IconLucideSmilePlus class="text-primary" />
          </Button>
        {/snippet}
      </PopoverEmojiPicker>
    </Tooltip>

    {#if canEdit}
      <Tooltip tip="Edit Message">
        <Toolbar.Button
          onclick={editMessage}
          class={[
            buttonVariants({ variant: "ghost", size: "iconSm" }),
            "backdrop-blur-none",
          ]}
          aria-label="Edit Message"
        >
          <IconTablerEdit />
        </Toolbar.Button>
      </Tooltip>
    {/if}

    {#if canDelete}
      <Tooltip tip="Delete Message">
        <Toolbar.Button
          onclick={deleteMessage}
          class={[
            buttonVariants({ variant: "ghost", size: "iconSm" }),
            "backdrop-blur-none",
          ]}
          aria-label="Delete Message"
        >
          <IconTablerTrash class="text-warning" />
        </Toolbar.Button>
      </Tooltip>
    {/if}

    <Tooltip tip="Create Thread">
      <Toolbar.Button
        onclick={startThreading}
        class={[
          buttonVariants({ variant: "ghost", size: "iconSm" }),
          "backdrop-blur-none",
        ]}
        aria-label="Create Thread"
      >
        <IconTablerNeedleThread class="text-primary" />
      </Toolbar.Button>
    </Tooltip>

    <Tooltip tip="Reply">
      <Toolbar.Button
        onclick={() => setReplyTo(message)}
        class={[
          buttonVariants({ variant: "ghost", size: "iconSm" }),
          "backdrop-blur-none",
        ]}
        aria-label="Reply"
      >
        <IconMdiReply />
      </Toolbar.Button>
    </Tooltip>
  </Toolbar.Root>
</BitsTooltip.Provider>
