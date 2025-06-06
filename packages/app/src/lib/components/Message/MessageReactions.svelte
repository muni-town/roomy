<script lang="ts">
  import { Toggle, Popover } from "bits-ui";
  import Icon from "@iconify/svelte";
  import EmojiPicker from "../helper/EmojiPicker.svelte";

  let {
    reactions,
    toggleReaction,
  }: {
    reactions: {
      emoji: string;
      count: number;
      user: boolean;
    }[];
    toggleReaction: (emoji: string) => void;
  } = $props();

  function onEmojiPick(emoji: string) {
    toggleReaction(emoji);
    isEmojiRowPickerOpen = false;
  }

  let isEmojiRowPickerOpen = $state(false);
</script>

{#if reactions.length > 0}
  <div class="flex gap-2 flex-wrap pl-14">
    {#each reactions as reaction}
      <Toggle.Root
        bind:pressed={
          () => {
            return reaction.user;
          },
          () => {
            toggleReaction(reaction.emoji);
          }
        }
        aria-label="toggle code visibility"
        class="inline-flex items-center justify-center gap-1 bg-secondary/30 hover:bg-secondary/50 min-w-10 h-8 rounded-xl text-base-content data-[state=on]:bg-secondary/80 data-[state=on]:text-secondary-content"
      >
        {reaction.emoji}
        {#if reaction.count > 1}
          <span class="text-xs">
            {reaction.count}
          </span>
        {/if}
      </Toggle.Root>
    {/each}

    <Popover.Root bind:open={isEmojiRowPickerOpen}>
      <Popover.Trigger class="p-2 hover:bg-white/5 rounded cursor-pointer">
        <Icon icon="lucide:smile-plus" class="text-primary" />
      </Popover.Trigger>
      <Popover.Content class="z-10">
        <EmojiPicker {onEmojiPick} />
      </Popover.Content>
    </Popover.Root>
  </div>
{/if}
