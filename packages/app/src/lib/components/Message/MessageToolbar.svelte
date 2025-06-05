<script lang="ts">
  import { Button, Toolbar, Popover } from "bits-ui";
  import Drawer from "../Drawer.svelte";
  import Icon from "@iconify/svelte";
  import EmojiPicker from "../EmojiPicker.svelte";

  function setReplyTo() {
    console.log("setReplyTo");
  }

  let {
    canEdit = true,
    canDelete = true,
    editMessage,
    deleteMessage,
    isDrawerOpen = $bindable(false),
    toggleReaction,
  }: {
    canEdit?: boolean;
    canDelete?: boolean;
    editMessage: () => void;
    deleteMessage: () => void;
    toggleReaction: (reaction: string) => void;
    isDrawerOpen?: boolean;
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

<Drawer bind:isDrawerOpen>
  <div class="flex gap-4 justify-center mb-4">
    <Button.Root
      onclick={() => {
        toggleReaction("👍");
        isDrawerOpen = false;
      }}
      class="dz-btn dz-btn-circle"
    >
      👍
    </Button.Root>
    <Button.Root
      onclick={() => {
        toggleReaction("😂");
        isDrawerOpen = false;
      }}
      class="dz-btn dz-btn-circle"
    >
      😂
    </Button.Root>

    <Popover.Root bind:open={isEmojiDrawerPickerOpen}>
      <Popover.Trigger class="dz-btn dz-btn-circle">
        <Icon icon="lucide:smile-plus" />
      </Popover.Trigger>
      <Popover.Content class="z-10">
        <EmojiPicker onEmojiPick={onEmojiPick} />
      </Popover.Content>
    </Popover.Root>
  </div>

  <div class="dz-join dz-join-vertical w-full">
    <Button.Root
      onclick={() => {
        setReplyTo();
        isDrawerOpen = false;
      }}
      class="dz-join-item dz-btn w-full"
    >
      <Icon icon="fa6-solid:reply" />
      Reply
    </Button.Root>
    {#if canEdit}
      <Button.Root
        onclick={() => {
          editMessage();
          isDrawerOpen = false;
        }}
        class="dz-join-item dz-btn w-full"
      >
        <Icon icon="tabler:edit" />
        Edit
      </Button.Root>
    {/if}
    {#if canDelete}
      <Button.Root
        onclick={() => deleteMessage()}
        class="dz-join-item dz-btn dz-btn-error w-full"
      >
        <Icon icon="tabler:trash" />
        Delete
      </Button.Root>
    {/if}
  </div>
</Drawer>

<Toolbar.Root
  class={`${!isEmojiToolbarPickerOpen && "hidden"} group-hover:flex absolute -top-2 right-0 bg-base-300 p-1 rounded items-center`}
>
  <Toolbar.Button
    onclick={() => toggleReaction("👍")}
    class="dz-btn dz-btn-ghost dz-btn-square"
  >
    👍
  </Toolbar.Button>
  <Toolbar.Button
    onclick={() => toggleReaction("😂")}
    class="dz-btn dz-btn-ghost dz-btn-square"
  >
    😂
  </Toolbar.Button>
  <Popover.Root bind:open={isEmojiToolbarPickerOpen}>
    <Popover.Trigger class="dz-btn dz-btn-ghost dz-btn-square">
      <Icon icon="lucide:smile-plus" />
    </Popover.Trigger>
    <Popover.Content class="z-10">
      <EmojiPicker onEmojiPick={onEmojiPick} />
    </Popover.Content>
  </Popover.Root>
  {#if canEdit}
    <Toolbar.Button
      onclick={() => editMessage()}
      class="dz-btn dz-btn-ghost dz-btn-square"
    >
      <Icon icon="tabler:edit" />
    </Toolbar.Button>
  {/if}

  {#if canDelete}
    <Toolbar.Button
      onclick={() => deleteMessage()}
      class="dz-btn dz-btn-ghost dz-btn-square"
    >
      <Icon icon="tabler:trash" class="text-warning" />
    </Toolbar.Button>
  {/if}

  <Toolbar.Button
    onclick={() => setReplyTo()}
    class="dz-btn dz-btn-ghost dz-btn-square"
  >
    <Icon icon="fa6-solid:reply" />
  </Toolbar.Button>
</Toolbar.Root>
