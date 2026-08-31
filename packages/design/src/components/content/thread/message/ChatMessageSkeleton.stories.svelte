<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import ChatMessageSkeleton from "./ChatMessageSkeleton.svelte";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/ChatMessageSkeleton",
    component: ChatMessageSkeleton,
  });
</script>

{#snippet template(args: { lines: number; mergeWithPrevious: boolean })}
  <div class="w-full max-w-2xl p-4">
    <ChatMessageSkeleton
      lines={args.lines}
      mergeWithPrevious={args.mergeWithPrevious}
    />
  </div>
{/snippet}

<Story
  name="Default"
  args={{ lines: 3, mergeWithPrevious: false }}
  {template}
/>

<Story
  name="Merged"
  args={{ lines: 2, mergeWithPrevious: true }}
  {template}
/>
