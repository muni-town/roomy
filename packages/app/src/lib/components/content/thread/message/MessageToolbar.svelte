<script lang="ts">
  import { Toolbar, Tooltip as BitsTooltip } from "bits-ui";
  import Tooltip from "$lib/components/helper/Tooltip.svelte";
  import { Button, buttonVariants } from "@fuxui/base";
  import { PopoverEmojiPicker } from "@fuxui/social";
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
    editMessage,
    message,
    startThreading,
    keepToolbarOpen = $bindable(false),
  }: {
    canEdit?: boolean;
    editMessage: () => void;
    message: Message;
    startThreading: () => void;
    keepToolbarOpen: boolean;
  } = $props();

  let isEmojiToolbarPickerOpen = $state(false);

  $effect(() => {
    keepToolbarOpen = isEmojiToolbarPickerOpen;
  });

  let canEditAndDelete = $derived(
    peerStatus.authState &&
      peerStatus.authState.state === "authenticated" &&
      (app.isSpaceAdmin || message.authorDid == peerStatus.authState.did),
  );

  async function deleteCurrentMessage() {
    const spaceId = app.joinedSpace?.id;
    if (!spaceId || !app.roomId) return;
    if (!canEditAndDelete) return;
    await deleteMessage(spaceId, app.roomId, message.id);
  }

  function onEmojiPick(emoji: string) {
    const spaceId = app.joinedSpace?.id;
    if (!spaceId || !app.roomId) return;

    const reaction = message.reactions.find(
      (x) => x.userId == app.did && x.reaction == emoji,
    );

    // If we haven't already made this reaction to this post.
    if (!reaction) {
      addReaction(spaceId, app.roomId, message.id, emoji);
    } else {
      // If we want to remove our reaction on this post
      removeReaction(spaceId, app.roomId, reaction.reactionId);
    }
    isEmojiToolbarPickerOpen = false;
  }
</script>

<BitsTooltip.Provider>
  <Toolbar.Root
    class={`${isEmojiToolbarPickerOpen ? "flex" : "hidden"} group-hover:flex shadow-lg border border-base-800/5 dark:border-base-300/10 backdrop-blur-sm absolute -top-4 right-2 bg-base-100/80 dark:bg-base-800/70 p-1 rounded-xl items-center`}
    onclick={(e) => e.stopPropagation()}
  >
    <Toolbar.Button
      onclick={() => onEmojiPick("👍")}
      class={[
        buttonVariants({ variant: "ghost", size: "iconSm" }),
        "backdrop-blur-none",
      ]}
    >
      👍
    </Toolbar.Button>
    <Toolbar.Button
      onclick={() => onEmojiPick("😂")}
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
            <IconSmilePlus class="text-primary" />
          </Button>
        {/snippet}
      </PopoverEmojiPicker>
    </Tooltip>

    {#if canEditAndDelete}
      <Tooltip tip="Edit Message">
        <Toolbar.Button
          onclick={editMessage}
          class={[
            buttonVariants({ variant: "ghost", size: "iconSm" }),
            "backdrop-blur-none",
          ]}
          aria-label="Edit Message"
        >
          <IconEdit />
        </Toolbar.Button>
      </Tooltip>
    {/if}

    {#if canEditAndDelete}
      <Tooltip tip="Delete Message">
        <Toolbar.Button
          onclick={deleteCurrentMessage}
          class={[
            buttonVariants({ variant: "ghost", size: "iconSm" }),
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
        onclick={startThreading}
        class={[
          buttonVariants({ variant: "ghost", size: "iconSm" }),
          "backdrop-blur-none",
        ]}
        aria-label="Create Thread"
      >
        <IconNeedleThread class="text-primary" />
      </Toolbar.Button>
    </Tooltip>

    <Tooltip tip="Reply">
      <Toolbar.Button
        onclick={() => messagingState.setReplyTo(message)}
        class={[
          buttonVariants({ variant: "ghost", size: "iconSm" }),
          "backdrop-blur-none",
        ]}
        aria-label="Reply"
      >
        <IconReply />
      </Toolbar.Button>
    </Tooltip>
  </Toolbar.Root>
</BitsTooltip.Provider>
