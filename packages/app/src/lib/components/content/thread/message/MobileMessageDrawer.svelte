<script lang="ts">
  import Drawer from "$lib/components/helper/Drawer.svelte";
  import Button from "$lib/components/ui/button/Button.svelte";
  import { PopoverEmojiPicker } from "@foxui/social";
  import { messagingState } from "../TimelineView.svelte";
  import type { Message } from "../ChatArea.svelte";

  import {
    IconSmilePlus,
    IconReply,
    IconNeedleThread,
    IconEdit,
    IconTrash,
  } from "@roomy/design/icons";
  import { peerStatus } from "$lib/workers";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import { addReaction, removeReaction } from "$lib/mutations/reaction";
  import { deleteMessage } from "$lib/mutations/message";

  let {
    message,
    open = $bindable(false),
    onStartThreading,
    onEditMessage,
  }: {
    message: Message | null;
    open: boolean;
    onStartThreading: () => void;
    onEditMessage: () => void;
  } = $props();

  let isEmojiPickerOpen = $state(false);

  let canEditAndDelete = $derived(
    message &&
      peerStatus.authState &&
      peerStatus.authState.state === "authenticated" &&
      (app.isSpaceAdmin || message.authorDid == peerStatus.authState.did),
  );

  async function deleteCurrentMessage() {
    const spaceId = app.joinedSpace?.id;
    if (!spaceId || !app.roomId || !message) return;
    if (!canEditAndDelete) return;
    await deleteMessage(spaceId, app.roomId, message.id);
    open = false;
  }

  function onEmojiPick(emoji: string) {
    const spaceId = app.joinedSpace?.id;
    if (!spaceId || !app.roomId || !message) return;

    const reaction = message.reactions.find(
      (x) => x.userId == app.did && x.reaction == emoji,
    );

    if (!reaction) {
      addReaction(spaceId, app.roomId, message.id, emoji);
    } else {
      removeReaction(spaceId, app.roomId, reaction.reactionId);
    }
    isEmojiPickerOpen = false;
    open = false;
  }
</script>

<Drawer
  {open}
  onOpenChange={(value) => {
    if (value) {
      open = true;
    } else if (!isEmojiPickerOpen) {
      open = false;
    }
  }}
>
  {#if message}
    <div class="flex gap-4 justify-center mb-4">
      <Button
        variant="ghost"
        size="icon"
        onclick={() => onEmojiPick("👍")}
        class="dz-btn dz-btn-circle"
      >
        👍
      </Button>
      <Button variant="ghost" size="icon" onclick={() => onEmojiPick("😂")}>
        😂
      </Button>

      <PopoverEmojiPicker
        bind:open={isEmojiPickerOpen}
        onpicked={(emoji) => onEmojiPick(emoji.unicode)}
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
          messagingState.setReplyTo(message);
          open = false;
        }}
        class="dz-join-item dz-btn w-full"
      >
        <IconReply />
        Reply
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
      {#if canEditAndDelete}
        <Button
          onclick={() => {
            onEditMessage();
            open = false;
          }}
          class="dz-join-item dz-btn w-full"
        >
          <IconEdit />
          Edit
        </Button>
      {/if}
      {#if canEditAndDelete}
        <Button
          onclick={deleteCurrentMessage}
          class="dz-join-item dz-btn dz-btn-error w-full"
        >
          <IconTrash />
          Delete
        </Button>
      {/if}
    </div>
  {/if}
</Drawer>
