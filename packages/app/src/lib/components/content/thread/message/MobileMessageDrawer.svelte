<script lang="ts">
  import Drawer from "$lib/components/helper/Drawer.svelte";
  import { Button } from "@fuxui/base";
  import { PopoverEmojiPicker } from "@fuxui/social";
  import { messagingState } from "../TimelineView.svelte";
  import type { Message } from "../ChatArea.svelte";

  import IconLucideSmilePlus from "~icons/lucide/smile-plus";
  import IconMdiReply from "~icons/mdi/reply";
  import IconTablerNeedleThread from "~icons/tabler/needle-thread";
  import IconTablerEdit from "~icons/tabler/edit";
  import IconTablerTrash from "~icons/tabler/trash";
  import { peerStatus } from "$lib/workers";
  import { current } from "$lib/queries";
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
      (current.isSpaceAdmin || message.authorDid == peerStatus.authState.did),
  );

  async function deleteCurrentMessage() {
    const spaceId = current.joinedSpace?.id;
    if (!spaceId || !current.roomId || !message) return;
    if (!canEditAndDelete) return;
    await deleteMessage(spaceId, current.roomId, message.id);
    open = false;
  }

  function onEmojiPick(emoji: string) {
    const spaceId = current.joinedSpace?.id;
    if (!spaceId || !current.roomId || !message) return;

    const reaction = message.reactions.find(
      (x) => x.userId == current.did && x.reaction == emoji,
    );

    if (!reaction) {
      addReaction(spaceId, current.roomId, message.id, emoji);
    } else {
      removeReaction(spaceId, current.roomId, reaction.reactionId);
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
            <IconLucideSmilePlus class="text-primary" />
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
        <IconMdiReply />
        Reply
      </Button>
      <Button
        onclick={() => {
          onStartThreading();
          open = false;
        }}
        class="dz-join-item dz-btn w-full"
      >
        <IconTablerNeedleThread />Create Thread
      </Button>
      {#if canEditAndDelete}
        <Button
          onclick={() => {
            onEditMessage();
            open = false;
          }}
          class="dz-join-item dz-btn w-full"
        >
          <IconTablerEdit />
          Edit
        </Button>
      {/if}
      {#if canEditAndDelete}
        <Button
          onclick={deleteCurrentMessage}
          class="dz-join-item dz-btn dz-btn-error w-full"
        >
          <IconTablerTrash />
          Delete
        </Button>
      {/if}
    </div>
  {/if}
</Drawer>
