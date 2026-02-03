<script lang="ts">
  import { Toolbar, Tooltip as BitsTooltip } from "bits-ui";
  import Tooltip from "$lib/components/helper/Tooltip.svelte";
  import { Button, buttonVariants } from "@fuxui/base";
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
      (current.isSpaceAdmin || message.authorDid == peerStatus.authState.did),
  );

  async function deleteCurrentMessage() {
    const spaceId = current.joinedSpace?.id;
    if (!spaceId || !current.roomId) return;
    if (!canEditAndDelete) return;
    await deleteMessage(spaceId, current.roomId, message.id);
  }

  function onEmojiPick(emoji: string) {
    const spaceId = current.joinedSpace?.id;
    if (!spaceId || !current.roomId) return;

    const reaction = message.reactions.find(
      (x) => x.userId == current.did && x.reaction == emoji,
    );

    // If we haven't already made this reaction to this post.
    if (!reaction) {
      addReaction(spaceId, current.roomId, message.id, emoji);
    } else {
      // If we want to remove our reaction on this post
      removeReaction(spaceId, current.roomId, reaction.reactionId);
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
            <IconLucideSmilePlus class="text-primary" />
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
          <IconTablerEdit />
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
        onclick={() => messagingState.setReplyTo(message)}
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
