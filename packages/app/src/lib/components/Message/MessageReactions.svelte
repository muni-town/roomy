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
    <!-- <Tooltip.Provider>
      {#each reactions as reaction}
        <Tooltip.Root>
          <Tooltip.Trigger>
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
          </Tooltip.Trigger>
          <Tooltip.Content class="z-50 bg-base-300 text-base-content p-2 rounded shadow-lg max-w-xs">
            <div class="flex flex-col gap-1">
              <div class="font-semibold text-sm">
                {reaction.emoji} {reaction.count} {reaction.count === 1 ? 'reaction' : 'reactions'}
              </div>
              {#if reaction.users.length > 0}
                <div class="text-xs text-base-content/80">
                  {#each reaction.users as user, i}
                    {user.name}{i < reaction.users.length - 1 ? ', ' : ''}
                  {/each}
                </div>
              {/if}
            </div>
          </Tooltip.Content>
        </Tooltip.Root>
      {/each}
    </Tooltip.Provider> -->
    <TooltipProvider>
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
    </TooltipProvider>

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
