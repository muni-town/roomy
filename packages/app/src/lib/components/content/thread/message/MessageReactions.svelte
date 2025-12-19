<script lang="ts">
  import { PopoverEmojiPicker } from "@fuxui/social";
  import { Button, Toggle, Tooltip } from "@fuxui/base";
  import IconLucideSmilePlus from "~icons/lucide/smile-plus";
  import { backend } from "$lib/workers";
  import { current } from "$lib/queries";
  import { newUlid } from "$lib/schema";
  import type { Message } from "../ChatArea.svelte";

  let {
    message,
  }: {
    message: Message;
  } = $props();

  let spaceId = $derived(current.joinedSpace?.id);

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
    if (!spaceId) return;

    // If we haven't already made this reaction to this post.
    if (
      !message.reactions.find(
        (x) => x.userId == current.did && x.reaction == emoji,
      )
    ) {
      backend.sendEvent(spaceId, {
        ulid: newUlid(),
        parent: current.roomId,
        variant: {
          kind: "space.roomy.room.addReaction.v0",
          data: {
            reactionTo: message.id,
            reaction: emoji,
          },
        },
      });
    }
    isEmojiRowPickerOpen = false;
  }

  function onEmojiButtonClick(emoji: string) {
    if (!spaceId) return;

    // If we haven't already made this reaction to this post.
    if (
      !message.reactions.find(
        (x) => x.userId == current.did && x.reaction == emoji,
      )
    ) {
      backend.sendEvent(spaceId, {
        ulid: newUlid(),
        parent: current.roomId,
        variant: {
          kind: "space.roomy.room.addReaction.v0",
          data: {
            reactionTo: message.id,
            reaction: emoji,
          },
        },
      });

      // If we want to remove our reaction on this post
    } else {
      backend.sendEvent(spaceId, {
        ulid: newUlid(),
        parent: current.roomId,
        variant: {
          kind: "space.roomy.room.removeReaction.v0",
          data: {
            reaction_to: message.id,
            reaction: emoji,
          },
        },
      });
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
            pressed={current.did! in users}
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
          <IconLucideSmilePlus class="text-primary" />
        </Button>
      {/snippet}
    </PopoverEmojiPicker>
  </div>
{/if}
