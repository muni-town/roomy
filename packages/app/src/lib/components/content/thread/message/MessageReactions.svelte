<script lang="ts">
  import Icon from "@iconify/svelte";
  import { PopoverEmojiPicker } from "@fuxui/social";
  import { Button, Toggle, Tooltip, TooltipProvider } from "@fuxui/base";

  let {
    reactions,
    toggleReaction,
  }: {
    reactions: {
      emoji: string;
      count: number;
      user: boolean;
      users: { id: string; name: string }[];
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
  <div class="flex gap-2 flex-wrap pl-14 z-10">
    {#each reactions as reaction}
      <Tooltip
        text={reaction.emoji +
          " " +
          reaction.users.map((user) => user.name).join(", ")}
      >
        {#snippet child({ props })}
          <Toggle
            {...props}
            pressed={reaction.user}
            onclick={() => toggleReaction(reaction.emoji)}
            class="px-2 h-7 data-[state=on]:bg-accent-400/20 dark:data-[state=on]:bg-accent-500/15"
          >
            {reaction.emoji}
            {#if reaction.count > 1}
              <span
                class="text-xs font-semibold text-base-900 dark:text-base-100"
              >
                {reaction.count}
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
          <Icon icon="lucide:smile-plus" class="text-primary" />
        </Button>
      {/snippet}
    </PopoverEmojiPicker>
  </div>
{/if}
