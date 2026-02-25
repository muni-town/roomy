<script lang="ts">
  import { PopoverEmojiPicker } from "@foxui/social";
  import { Toggle, Tooltip } from "@foxui/core";
  import Button from "$lib/components/ui/button/Button.svelte";
  import { IconSmilePlus } from "@roomy/design/icons";
  import { getAppState } from "$lib/queries";
  const app = getAppState();
  import type { Message } from "../ChatArea.svelte";
  import { addReaction, removeReaction } from "$lib/mutations/reaction";

  let {
    message,
  }: {
    message: Message;
  } = $props();

  let spaceId = $derived(app.joinedSpace?.id);

  let sortedReactions = $derived(
    message.reactions.reduce(
      (out, item) => {
        if (!(item.reaction in out)) {
          out[item.reaction] = {};
        }
        out[item.reaction]![item.userId] = item.userName;
        return out;
      },
      {} as { [reaction: string]: { [userId: string]: string } },
    ),
  );

  function onEmojiPick(emoji: string) {
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
    isEmojiRowPickerOpen = false;
  }

  function onEmojiButtonClick(emoji: string) {
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
  }

  let isEmojiRowPickerOpen = $state(false);
</script>

{#if message.reactions.length > 0}
  <div class="flex gap-2 flex-wrap pl-14 z-10">
    {#each Object.entries(sortedReactions) as [emoji, users]}
      <Tooltip text={emoji + " " + Object.values(users).join(", ")}>
        {#snippet child({ props })}
          <Toggle
            {...props}
            pressed={app.did! in users}
            onclick={() => onEmojiButtonClick(emoji)}
            class="px-2 h-7 data-[state=on]:bg-accent-400/20 dark:data-[state=on]:bg-accent-500/15"
          >
            {emoji}
            {#if Object.keys(users).length > 1}
              <span
                class="text-xs font-semibold text-base-900 dark:text-base-100"
              >
                {Object.keys(users).length}
              </span>
            {/if}
          </Toggle>
        {/snippet}
      </Tooltip>
    {/each}

    <PopoverEmojiPicker
      bind:open={isEmojiRowPickerOpen}
      onpicked={(emoji) => onEmojiPick(emoji.unicode)}
    >
      {#snippet child({ props })}
        <Button size="icon" variant="ghost" {...props}>
          <IconSmilePlus class="text-primary" />
        </Button>
      {/snippet}
    </PopoverEmojiPicker>
  </div>
{/if}
