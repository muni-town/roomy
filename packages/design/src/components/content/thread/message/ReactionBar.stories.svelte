<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ReactionBar, {
    type ReactionGroup,
  } from "./ReactionBar.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/ReactionBar",
    component: ReactionBar,
  });

  const reactions: ReactionGroup[] = [
    { emoji: "👍", count: 4, pressed: true },
    { emoji: "❤️", count: 2, pressed: false },
    { emoji: "🎉", count: 1, pressed: false },
  ];
</script>

<Story
  name="Default"
  args={{
    reactions,
    onToggleReaction: () => {},
    onHover: () => {},
    tooltipOpenByEmoji: {},
    tooltipReactorsByEmoji: {},
  }}
/>

<Story
  name="Empty"
  args={{
    reactions: [],
    onToggleReaction: () => {},
    onHover: () => {},
    tooltipOpenByEmoji: {},
    tooltipReactorsByEmoji: {},
  }}
/>
