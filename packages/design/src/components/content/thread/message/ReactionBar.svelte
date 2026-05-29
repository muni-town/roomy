<script lang="ts" module>
  export type ReactionInfo = {
    reaction: string;
    userId: string;
    userName: string;
    reactionId: string;
  };
</script>

<script lang="ts">
  import { PopoverEmojiPicker } from "@foxui/social";
  import { Toggle } from "@foxui/core";
  import Button from "../../../ui/button/Button.svelte";
  import { IconSmilePlus } from "../../../../icons/index";

  let {
    reactions,
    currentUserDid,
    onToggleReaction,
  }: {
    reactions: ReactionInfo[];
    /** DID of the viewing user — controls "pressed" state for own reactions. */
    currentUserDid?: string;
    /** Called when the user clicks an emoji (either existing reaction or picker). */
    onToggleReaction: (emoji: string) => void;
  } = $props();

  let sortedReactions = $derived(
    reactions.reduce(
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

  let isEmojiRowPickerOpen = $state(false);

  function handlePick(emoji: string) {
    onToggleReaction(emoji);
    isEmojiRowPickerOpen = false;
  }
</script>

{#if reactions.length > 0}
  <div class="flex gap-2 items-center flex-wrap pl-12 z-10">
    {#each Object.entries(sortedReactions) as [emoji, users]}
      {@const count = Object.keys(users).length}
      <Toggle
        title={emoji + " " + Object.values(users).join(", ")}
        pressed={currentUserDid !== undefined && currentUserDid in users}
        onclick={() => onToggleReaction(emoji)}
        class={`h-7 data-[state=on]:bg-accent-400/20 dark:data-[state=on]:bg-accent-500/15 min-w-4 p-1.5 ${count > 1 ? "px-2" : ""}`}
      >
        <span>{emoji}</span>
        {#if count > 1}
          <span class="text-xs font-semibold text-base-900 dark:text-base-100">
            {count}
          </span>
        {/if}
      </Toggle>
    {/each}

    <PopoverEmojiPicker
      bind:open={isEmojiRowPickerOpen}
      onpicked={(emoji) => handlePick(emoji.unicode)}
    >
      {#snippet child({ props })}
        <Button size="icon" variant="ghost" {...props} class="p-1.5">
          <IconSmilePlus class="text-primary" />
        </Button>
      {/snippet}
    </PopoverEmojiPicker>
  </div>
{/if}
